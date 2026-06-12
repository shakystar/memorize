import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../src/domain/common.js';
import { createObservation } from '../../src/domain/entities.js';
import {
  consolidateThreshold,
  readLastConsolidateAttempt,
  shouldTriggerThresholdConsolidate,
} from '../../src/services/consolidate-service.js';
import {
  CONSOLIDATE_INLINE_ENV_VAR,
  runClaudeHook,
} from '../../src/services/hook-service.js';
import { requireBoundProjectId } from '../../src/services/project-service.js';
import { rebuildProjectProjection } from '../../src/services/projection-store.js';
import { closeAll, getDb } from '../../src/storage/db.js';
import { appendEvent, readEvents } from '../../src/storage/event-store.js';

const projectId = 'proj_threshold_test1';
const ts = '2026-06-12T00:00:00.000Z';

let sandbox: string;
let savedThreshold: string | undefined;
let savedInline: string | undefined;

async function seedProject(): Promise<void> {
  await appendEvent({
    type: 'project.created',
    projectId,
    scopeType: 'project',
    scopeId: projectId,
    actor: 'test',
    payload: {
      id: projectId,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: ts,
      updatedAt: ts,
      title: 'Threshold',
      summary: 'Threshold consolidate test project',
      goals: [],
      status: 'active',
      rootPath: '/tmp/threshold',
      activeWorkstreamIds: [],
      activeTaskIds: [],
      acceptedDecisionIds: [],
      ruleIds: [],
    } as never,
  });
  await rebuildProjectProjection(projectId);
}

async function appendObservations(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const observation = createObservation({
      projectId,
      signal: 'write-tool',
      sessionId: 'sess_threshold_1',
      toolName: 'Write',
      summary: `Write: /repo/file-${i}.ts`,
      filePath: `/repo/file-${i}.ts`,
    });
    await appendEvent({
      type: 'observation.captured',
      projectId,
      scopeType: 'session',
      scopeId: 'sess_threshold_1',
      actor: 'claude',
      payload: observation,
    });
  }
  await rebuildProjectProjection(projectId, { reindexSearch: false });
}

/** Simulate a successful consolidation: advance the watermark to the
 *  newest event so pendingObservations drops to 0. */
async function advanceWatermarkToHead(): Promise<void> {
  const events = await readEvents(projectId);
  const last = events[events.length - 1]!;
  getDb(projectId)
    .prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run('cls_consolidate_watermark', last.id);
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-threshold-'));
  process.env.MEMORIZE_ROOT = sandbox;
  savedThreshold = process.env.MEMORIZE_CONSOLIDATE_THRESHOLD;
  savedInline = process.env[CONSOLIDATE_INLINE_ENV_VAR];
  await seedProject();
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  if (savedThreshold === undefined) {
    delete process.env.MEMORIZE_CONSOLIDATE_THRESHOLD;
  } else {
    process.env.MEMORIZE_CONSOLIDATE_THRESHOLD = savedThreshold;
  }
  if (savedInline === undefined) {
    delete process.env[CONSOLIDATE_INLINE_ENV_VAR];
  } else {
    process.env[CONSOLIDATE_INLINE_ENV_VAR] = savedInline;
  }
  await rm(sandbox, { recursive: true, force: true });
});

describe('consolidateThreshold (env parsing)', () => {
  it('defaults to 20 when unset', () => {
    delete process.env.MEMORIZE_CONSOLIDATE_THRESHOLD;
    expect(consolidateThreshold()).toBe(20);
  });

  it('reads a positive integer from the env', () => {
    process.env.MEMORIZE_CONSOLIDATE_THRESHOLD = '5';
    expect(consolidateThreshold()).toBe(5);
  });

  it('0 disables the feature', () => {
    process.env.MEMORIZE_CONSOLIDATE_THRESHOLD = '0';
    expect(consolidateThreshold()).toBe(0);
  });

  it.each(['abc', '-3', '2.5', ''])(
    'falls back to 20 on invalid value %j',
    (raw) => {
      process.env.MEMORIZE_CONSOLIDATE_THRESHOLD = raw;
      expect(consolidateThreshold()).toBe(20);
    },
  );
});

describe('shouldTriggerThresholdConsolidate', () => {
  beforeEach(() => {
    process.env.MEMORIZE_CONSOLIDATE_THRESHOLD = '3';
  });

  it('stays quiet below the threshold', async () => {
    await appendObservations(2);
    expect(shouldTriggerThresholdConsolidate(projectId)).toBe(false);
  });

  it('fires at the threshold', async () => {
    await appendObservations(3);
    expect(shouldTriggerThresholdConsolidate(projectId)).toBe(true);
  });

  it('never fires when disabled (0), regardless of backlog', async () => {
    process.env.MEMORIZE_CONSOLIDATE_THRESHOLD = '0';
    await appendObservations(10);
    expect(shouldTriggerThresholdConsolidate(projectId)).toBe(false);
  });

  it('debounces: same watermark within the TTL fires only once', async () => {
    await appendObservations(3);
    const t0 = new Date('2026-06-12T10:00:00.000Z');
    expect(shouldTriggerThresholdConsolidate(projectId, t0)).toBe(true);
    const t1 = new Date('2026-06-12T10:00:30.000Z'); // +30s, same watermark
    expect(shouldTriggerThresholdConsolidate(projectId, t1)).toBe(false);
  });

  it('re-arms after the TTL expires (dead detached child)', async () => {
    await appendObservations(3);
    const t0 = new Date('2026-06-12T10:00:00.000Z');
    expect(shouldTriggerThresholdConsolidate(projectId, t0)).toBe(true);
    const t1 = new Date('2026-06-12T10:06:00.000Z'); // +6min > 5min TTL
    expect(shouldTriggerThresholdConsolidate(projectId, t1)).toBe(true);
  });

  it('re-arms when the watermark advances (consolidation succeeded)', async () => {
    await appendObservations(3);
    const t0 = new Date('2026-06-12T10:00:00.000Z');
    expect(shouldTriggerThresholdConsolidate(projectId, t0)).toBe(true);
    await advanceWatermarkToHead(); // pending drops to 0
    const t1 = new Date('2026-06-12T10:00:30.000Z');
    expect(shouldTriggerThresholdConsolidate(projectId, t1)).toBe(false); // 0 < 3
    await appendObservations(3); // a fresh backlog past the NEW watermark
    expect(shouldTriggerThresholdConsolidate(projectId, t1)).toBe(true);
  });
});

describe('handlePostToolUse — threshold boundary wiring (inline mode)', () => {
  function postToolUsePayload(filePath: string): string {
    return JSON.stringify({
      session_id: 'agent-uuid-th-1',
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: filePath },
    });
  }

  async function fireWrite(i: number): Promise<void> {
    await runClaudeHook({
      eventName: 'PostToolUse',
      cwd: sandbox,
      stdinPayload: postToolUsePayload(join(sandbox, `f-${i}.ts`)),
    });
  }

  beforeEach(() => {
    process.env[CONSOLIDATE_INLINE_ENV_VAR] = '1'; // sync, no detached child
    process.env.MEMORIZE_CONSOLIDATE_THRESHOLD = '2';
  });

  it('consolidates exactly once when the backlog reaches N', async () => {
    await fireWrite(0); // pending 1 < 2 — no consolidation
    let hookProjectId = await requireBoundProjectId(sandbox);
    let types = (await readEvents(hookProjectId)).map((e) => e.type);
    expect(types.filter((t) => t === 'memory.consolidated')).toHaveLength(0);

    await fireWrite(1); // pending 2 >= 2 — fires inline
    hookProjectId = await requireBoundProjectId(sandbox);
    types = (await readEvents(hookProjectId)).map((e) => e.type);
    const afterSecond = types.filter((t) => t === 'memory.consolidated').length;
    expect(afterSecond).toBeGreaterThan(0);

    // The attempt is attributed to the 'threshold' boundary (#51).
    expect(readLastConsolidateAttempt(hookProjectId)?.boundary).toBe(
      'threshold',
    );

    await fireWrite(2); // pending 1 past the advanced watermark — quiet
    types = (await readEvents(hookProjectId)).map((e) => e.type);
    expect(types.filter((t) => t === 'memory.consolidated')).toHaveLength(
      afterSecond,
    );
  });

  it('a filtered (read-only) tool never runs the threshold check', async () => {
    await fireWrite(0);
    await runClaudeHook({
      eventName: 'PostToolUse',
      cwd: sandbox,
      stdinPayload: JSON.stringify({
        session_id: 'agent-uuid-th-1',
        hook_event_name: 'PostToolUse',
        tool_name: 'Read', // filter rejects → capture undefined → no check
        tool_input: { file_path: join(sandbox, 'f-0.ts') },
      }),
    });
    const hookProjectId = await requireBoundProjectId(sandbox);
    const types = (await readEvents(hookProjectId)).map((e) => e.type);
    expect(types.filter((t) => t === 'memory.consolidated')).toHaveLength(0);
  });
});
