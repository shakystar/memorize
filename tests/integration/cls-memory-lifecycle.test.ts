import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderClaudeStartupContext } from '../../src/adapters/claude/renderer.js';
import { CURRENT_SCHEMA_VERSION } from '../../src/domain/common.js';
import { captureObservation } from '../../src/services/capture-service.js';
import {
  type Consolidator,
  consolidate,
} from '../../src/services/consolidate-service.js';
import {
  reinforceInjectedMemories,
  retrieveMemoryContext,
} from '../../src/services/memory-retrieval-service.js';
import {
  listRecentObservations,
  listValidMemories,
  rebuildProjectProjection,
} from '../../src/services/projection-store.js';
import { searchProject } from '../../src/services/search-service.js';
import { closeAll, getDb } from '../../src/storage/db.js';
import { appendEvent, readEvents } from '../../src/storage/event-store.js';

const projectId = 'proj_cls_test1';
const ts = '2026-06-08T00:00:00.000Z';

let sandbox: string;

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
      title: 'CLS',
      summary: 'CLS lifecycle test project',
      goals: [],
      status: 'active',
      rootPath: '/tmp/cls',
      activeWorkstreamIds: [],
      activeTaskIds: [],
      acceptedDecisionIds: [],
      ruleIds: [],
    } as never,
  });
  await rebuildProjectProjection(projectId);
}

function postToolUsePayload(toolName: string, input: object): string {
  return JSON.stringify({
    session_id: 'agent-uuid-1',
    tool_name: toolName,
    tool_input: input,
  });
}

async function captureWrite(filePath: string) {
  return captureObservation({
    projectId,
    agent: 'claude',
    cwd: sandbox,
    rawPayload: postToolUsePayload('Write', { file_path: filePath }),
  });
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-cls-'));
  process.env.MEMORIZE_ROOT = sandbox;
  delete process.env.MEMORIZE_LLM_API_KEY;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('CLS capture → consolidate → retrieve (in-process)', () => {
  it('captures whitelisted tool use as observation.captured; rejects read-only tools', async () => {
    await seedProject();

    const captured = await captureWrite('/repo/src/index.ts');
    expect(captured?.signal).toBe('write-tool');

    const rejected = await captureObservation({
      projectId,
      agent: 'claude',
      cwd: sandbox,
      rawPayload: postToolUsePayload('Read', { file_path: '/repo/src/index.ts' }),
    });
    expect(rejected).toBeUndefined();

    const types = (await readEvents(projectId)).map((e) => e.type);
    expect(types.filter((t) => t === 'observation.captured')).toHaveLength(1);

    // Projection row landed (rebuild ran with reindexSearch:false).
    const observations = listRecentObservations(projectId, { limit: 10 });
    expect(observations).toHaveLength(1);
    expect(observations[0]!.summary).toContain('/repo/src/index.ts');
  });

  it('consolidates at the boundary (rule-based, no key), idempotently, append-only', async () => {
    await seedProject();
    await captureWrite('/repo/src/a.ts');
    await captureWrite('/repo/src/b.ts');

    const before = (await readEvents(projectId)).map((e) => ({
      id: e.id,
      json: JSON.stringify(e),
    }));

    const first = await consolidate({ projectId, actor: 'test' });
    expect(first.extractor).toBe('rule-based');
    expect(first.observationsProcessed).toBe(2);
    expect(first.consolidated).toBeGreaterThan(0);

    // Long-term layer materialized + searchable.
    const memories = listValidMemories(projectId);
    expect(memories).toHaveLength(first.consolidated);
    expect(memories[0]!.memory.text).toContain('/repo/src/a.ts');
    const hits = searchProject(projectId, 'a.ts').filter(
      (hit) => hit.kind === 'memory',
    );
    expect(hits.length).toBeGreaterThan(0);

    // Idempotent: the watermark advanced, so a second boundary is a no-op.
    const second = await consolidate({ projectId, actor: 'test' });
    expect(second.consolidated).toBe(0);
    expect(second.observationsProcessed).toBe(0);

    // Append-only invariant: every pre-existing event survives BYTE-identical;
    // the log only grew.
    const after = await readEvents(projectId);
    expect(after.length).toBeGreaterThan(before.length);
    for (const [index, prior] of before.entries()) {
      expect(after[index]!.id).toBe(prior.id);
      expect(JSON.stringify(after[index]!)).toBe(prior.json);
    }
  });

  it('extractor failure does NOT advance the watermark; the next boundary retries the window (#43)', async () => {
    await seedProject();
    await captureWrite('/repo/src/a.ts');

    const failing: Consolidator = {
      async extract(): Promise<never> {
        throw new Error('unparseable LLM reply');
      },
    };
    await expect(
      consolidate({ projectId, actor: 'test', consolidator: failing }),
    ).rejects.toThrow('unparseable LLM reply');
    expect(listValidMemories(projectId)).toHaveLength(0);

    // Watermark untouched — the same observations are re-consolidated.
    const retry = await consolidate({ projectId, actor: 'test' });
    expect(retry.observationsProcessed).toBe(1);
    expect(retry.consolidated).toBeGreaterThan(0);
  });

  it('a genuinely empty extraction advances the watermark (observations consumed)', async () => {
    await seedProject();
    await captureWrite('/repo/src/a.ts');

    const empty: Consolidator = {
      async extract() {
        return [];
      },
    };
    const first = await consolidate({
      projectId,
      actor: 'test',
      consolidator: empty,
    });
    expect(first.observationsProcessed).toBe(1);
    expect(first.consolidated).toBe(0);

    // Clean empty result consumed the window — the next boundary is a no-op.
    const second = await consolidate({ projectId, actor: 'test' });
    expect(second.observationsProcessed).toBe(0);
    expect(second.consolidated).toBe(0);
  });

  it('watermark loss does NOT duplicate memories (sourceObservationIds dedup guard)', async () => {
    // Events survive export/sync/migrate but the per-project meta table
    // (and thus the watermark) does not. Simulate that loss and prove the
    // next boundary skips already-consolidated observations instead of
    // re-distilling the whole history into duplicates.
    await seedProject();
    await captureWrite('/repo/src/a.ts');
    const first = await consolidate({ projectId, actor: 'test' });
    expect(first.consolidated).toBeGreaterThan(0);
    const memoriesBefore = listValidMemories(projectId).length;

    getDb(projectId)
      .prepare("DELETE FROM meta WHERE key = 'cls_consolidate_watermark'")
      .run();

    const retry = await consolidate({ projectId, actor: 'test' });
    expect(retry.consolidated).toBe(0);
    expect(retry.observationsProcessed).toBe(0);
    expect(listValidMemories(projectId)).toHaveLength(memoriesBefore);

    // The watermark was re-established, so the stale window is not
    // rescanned on every subsequent boundary.
    const watermark = getDb(projectId)
      .prepare("SELECT value FROM meta WHERE key = 'cls_consolidate_watermark'")
      .get() as { value: string } | undefined;
    expect(watermark?.value).toBeTruthy();
  });

  it('supersede invalidates without deleting (D4) and drops hallucinated ids', async () => {
    await seedProject();
    await captureWrite('/repo/src/a.ts');
    await consolidate({ projectId, actor: 'test' });
    const oldMemory = listValidMemories(projectId)[0]!.memory;

    await captureWrite('/repo/src/c.ts');
    const contradicting: Consolidator = {
      async extract() {
        return [
          {
            kind: 'decision' as const,
            text: 'Reversed the earlier approach entirely',
            salience: 8,
            supersedesMemoryId: oldMemory.id,
            supersedeReason: 'direction change',
          },
          {
            kind: 'progress' as const,
            text: 'Bogus supersede target must be ignored',
            salience: 3,
            supersedesMemoryId: 'mem_hallucinated_404',
          },
        ];
      },
    };
    const result = await consolidate({
      projectId,
      actor: 'test',
      consolidator: contradicting,
    });
    expect(result.superseded).toBe(1);

    // Old memory left the valid set but its row + events survive.
    const validIds = listValidMemories(projectId).map((row) => row.memory.id);
    expect(validIds).not.toContain(oldMemory.id);
    const row = getDb(projectId)
      .prepare('SELECT invalid_at, superseded_by FROM memories WHERE id = ?')
      .get(oldMemory.id) as { invalid_at: string; superseded_by: string };
    expect(row.invalid_at).toBeTruthy();
    const types = (await readEvents(projectId)).map((e) => e.type);
    expect(types.filter((t) => t === 'memory.superseded')).toHaveLength(1);
  });

  it('retrieves ranked memories + observation tail, reinforces, and carry-over survives rebuild', async () => {
    await seedProject();
    await captureWrite('/repo/src/a.ts');
    await consolidate({ projectId, actor: 'test' });

    const retrieved = retrieveMemoryContext(projectId);
    expect(retrieved.memories.length).toBeGreaterThan(0);
    expect(retrieved.observations.length).toBeGreaterThan(0);

    // Reinforcement stamps last_accessed_at on the projection only.
    reinforceInjectedMemories(projectId, retrieved.memories);
    const memoryId = retrieved.memories[0]!.memory.id;
    const stamped = () =>
      (
        getDb(projectId)
          .prepare('SELECT last_accessed_at FROM memories WHERE id = ?')
          .get(memoryId) as { last_accessed_at: string | null }
      ).last_accessed_at;
    expect(stamped()).toBeTruthy();
    const stampBefore = stamped();

    // Routine rebuild (the every-write path) must NOT lose the stamp (⑤).
    await rebuildProjectProjection(projectId);
    expect(stamped()).toBe(stampBefore);

    // The renderer surfaces the long-term layer.
    const rendered = renderClaudeStartupContext({
      projectSummary: 'CLS lifecycle test project',
      projectRules: [],
      openConflicts: [],
      mustReadTopics: [],
      consolidatedMemories: retrieved.memories.map(({ memory }) => ({
        id: memory.id,
        kind: memory.kind,
        text: memory.text,
        salience: memory.salience,
        createdAt: memory.createdAt,
      })),
      recentObservations: retrieved.observations.map((observation) => ({
        signal: observation.signal,
        createdAt: observation.createdAt,
        ...(observation.summary ? { summary: observation.summary } : {}),
      })),
    });
    expect(rendered).toContain('Consolidated memories:');
    expect(rendered).toContain('Recent work signals');
  });
});

describe('CLS hook lifecycle (spawned, end-to-end)', () => {
  const repoRoot = process.cwd();
  const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

  function hookEnv(memorizeRoot: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, MEMORIZE_ROOT: memorizeRoot };
    // Force the rule-based extractor regardless of the host machine's env.
    delete env.MEMORIZE_LLM_API_KEY;
    return env;
  }

  function runHook(
    cwd: string,
    memorizeRoot: string,
    eventName: string,
    stdinPayload: object,
  ) {
    return spawnSync(
      'node',
      [tsxCliPath, cliEntryPath, 'hook', 'claude', eventName],
      {
        cwd,
        input: JSON.stringify(stdinPayload),
        encoding: 'utf8',
        env: hookEnv(memorizeRoot),
      },
    );
  }

  it('PostToolUse captures → PostCompact consolidates → next SessionStart injects', async () => {
    const hookSandbox = await mkdtemp(join(tmpdir(), 'memorize-cls-hooks-'));
    const memorizeRoot = join(hookSandbox, '.memorize-home');
    try {
      const start = runHook(hookSandbox, memorizeRoot, 'SessionStart', {
        cwd: hookSandbox,
        hook_event_name: 'SessionStart',
        session_id: 'cls-uuid-1',
      });
      expect(start.status).toBe(0);

      // Whitelisted tool → captured; read-only tool → filtered out.
      const write = runHook(hookSandbox, memorizeRoot, 'PostToolUse', {
        cwd: hookSandbox,
        hook_event_name: 'PostToolUse',
        session_id: 'cls-uuid-1',
        tool_name: 'Write',
        tool_input: { file_path: join(hookSandbox, 'feature.ts') },
      });
      expect(write.status).toBe(0);
      const read = runHook(hookSandbox, memorizeRoot, 'PostToolUse', {
        cwd: hookSandbox,
        hook_event_name: 'PostToolUse',
        session_id: 'cls-uuid-1',
        tool_name: 'Read',
        tool_input: { file_path: join(hookSandbox, 'feature.ts') },
      });
      expect(read.status).toBe(0);

      // Compaction boundary consolidates the captured window.
      const compact = runHook(hookSandbox, memorizeRoot, 'PostCompact', {
        cwd: hookSandbox,
        hook_event_name: 'PostCompact',
        session_id: 'cls-uuid-1',
        compact_summary: 'Working on feature.ts',
      });
      expect(compact.status).toBe(0);

      // Verify the event log from this process.
      process.env.MEMORIZE_ROOT = memorizeRoot;
      closeAll();
      const projectDirs = await readdir(join(memorizeRoot, 'projects'));
      const types = (await readEvents(projectDirs[0]!)).map((e) => e.type);
      expect(types.filter((t) => t === 'observation.captured')).toHaveLength(1);
      expect(
        types.filter((t) => t === 'memory.consolidated').length,
      ).toBeGreaterThan(0);
      closeAll();

      // The NEXT session sees the consolidated memory in its startup
      // context — "끊김 없이 이어가기".
      const start2 = runHook(hookSandbox, memorizeRoot, 'SessionStart', {
        cwd: hookSandbox,
        hook_event_name: 'SessionStart',
        session_id: 'cls-uuid-2',
      });
      expect(start2.status).toBe(0);
      expect(start2.stdout).toContain('Consolidated memories:');
      expect(start2.stdout).toContain('feature.ts');
    } finally {
      closeAll();
      await rm(hookSandbox, { recursive: true, force: true });
    }
  });
});
