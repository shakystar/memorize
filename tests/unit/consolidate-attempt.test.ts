import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../src/domain/common.js';
import { createObservation } from '../../src/domain/entities.js';
import {
  type Consolidator,
  ExtractionParseError,
  classifyConsolidateError,
  consolidate,
  readLastConsolidateAttempt,
} from '../../src/services/consolidate-service.js';
import { rebuildProjectProjection } from '../../src/services/projection-store.js';
import { closeAll, getDb } from '../../src/storage/db.js';
import { appendEvent } from '../../src/storage/event-store.js';

const projectId = 'proj_attempt_test1';
const ts = '2026-06-10T00:00:00.000Z';

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
      title: 'Attempt',
      summary: 'Attempt telemetry test project',
      goals: [],
      status: 'active',
      rootPath: '/tmp/attempt',
      activeWorkstreamIds: [],
      activeTaskIds: [],
      acceptedDecisionIds: [],
      ruleIds: [],
    } as never,
  });
  await rebuildProjectProjection(projectId);
}

async function appendObservation(): Promise<void> {
  const observation = createObservation({
    projectId,
    signal: 'write-tool',
    sessionId: 'sess_attempt_1',
    toolName: 'Write',
    summary: 'Write: /repo/attempt.ts',
    filePath: '/repo/attempt.ts',
  });
  await appendEvent({
    type: 'observation.captured',
    projectId,
    scopeType: 'session',
    scopeId: 'sess_attempt_1',
    actor: 'claude',
    payload: observation,
  });
}

const oneMemory: Consolidator = {
  async extract() {
    return [{ kind: 'progress' as const, text: 'Edited attempt.ts', salience: 3 }];
  },
};

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-attempt-'));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('classifyConsolidateError (#51 outcome mapping)', () => {
  it('maps ExtractionParseError to parse-error', () => {
    expect(
      classifyConsolidateError(new ExtractionParseError('no JSON array')),
    ).toBe('parse-error');
  });

  it('maps CLI extractor timeouts to timeout', () => {
    expect(
      classifyConsolidateError(
        new Error('claude CLI extractor timed out after 90000ms'),
      ),
    ).toBe('timeout');
  });

  it('maps AbortSignal.timeout TimeoutError to timeout', () => {
    const error = new Error('The operation was aborted due to timeout');
    error.name = 'TimeoutError';
    expect(classifyConsolidateError(error)).toBe('timeout');
  });

  it('maps HTTP status failures to http-error', () => {
    expect(classifyConsolidateError(new Error('LLM extractor HTTP 503'))).toBe(
      'http-error',
    );
  });

  it('maps lock acquisition failures to lock-contention', () => {
    expect(
      classifyConsolidateError(
        new Error('withFileLock: could not acquire /x/consolidate.lock after 360000ms'),
      ),
    ).toBe('lock-contention');
  });

  it('maps anything else to error', () => {
    expect(classifyConsolidateError(new Error('ENOENT: no such file'))).toBe('error');
    expect(classifyConsolidateError('string throw')).toBe('error');
  });
});

describe('consolidate() records the attempt in meta (#51)', () => {
  it('records ok with counts on success', async () => {
    await seedProject();
    await appendObservation();

    const result = await consolidate({
      projectId,
      actor: 'test',
      consolidator: oneMemory,
    });
    expect(result.consolidated).toBe(1);

    const attempt = readLastConsolidateAttempt(projectId);
    expect(attempt).toBeDefined();
    expect(attempt!.outcome).toBe('ok');
    expect(attempt!.boundary).toBe('manual');
    expect(attempt!.backend).toBe('custom');
    expect(attempt!.pendingObservations).toBe(1);
    expect(attempt!.consolidated).toBe(1);
    expect(attempt!.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(attempt!.at))).toBe(false);
    expect(attempt!.error).toBeUndefined();
  });

  it('records noop when nothing is pending', async () => {
    await seedProject();

    const result = await consolidate({
      projectId,
      actor: 'test',
      consolidator: oneMemory,
    });
    expect(result.observationsProcessed).toBe(0);

    const attempt = readLastConsolidateAttempt(projectId);
    expect(attempt!.outcome).toBe('noop');
    expect(attempt!.pendingObservations).toBe(0);
  });

  it('records the failure outcome, boundary, and error on extractor failure', async () => {
    await seedProject();
    await appendObservation();

    const failing: Consolidator = {
      async extract(): Promise<never> {
        throw new ExtractionParseError('LLM reply contains no JSON array');
      },
    };
    await expect(
      consolidate({
        projectId,
        actor: 'test',
        boundary: 'post-compact',
        consolidator: failing,
      }),
    ).rejects.toThrow('no JSON array');

    const attempt = readLastConsolidateAttempt(projectId);
    expect(attempt!.outcome).toBe('parse-error');
    expect(attempt!.boundary).toBe('post-compact');
    expect(attempt!.backend).toBe('custom');
    expect(attempt!.pendingObservations).toBe(1);
    expect(attempt!.error).toContain('no JSON array');
    expect(attempt!.consolidated).toBeUndefined();
  });

  it('a failing attempt write never masks the result or the original error', async () => {
    await seedProject();
    await appendObservation();
    // Block ONLY the attempt-telemetry write; the watermark write stays fine.
    getDb(projectId).exec(
      "CREATE TRIGGER block_attempt_write BEFORE INSERT ON meta " +
        "WHEN NEW.key = 'cls_consolidate_last_attempt' " +
        "BEGIN SELECT RAISE(ABORT, 'attempt write blocked'); END;",
    );

    // Success path still resolves even though recording fails.
    const result = await consolidate({
      projectId,
      actor: 'test',
      consolidator: oneMemory,
    });
    expect(result.consolidated).toBe(1);
    expect(readLastConsolidateAttempt(projectId)).toBeUndefined();

    // Failure path rethrows the ORIGINAL error, not the recording failure.
    await appendObservation();
    const failing: Consolidator = {
      async extract(): Promise<never> {
        throw new Error('extractor exploded');
      },
    };
    await expect(
      consolidate({ projectId, actor: 'test', consolidator: failing }),
    ).rejects.toThrow('extractor exploded');
  });
});

describe('consolidate() — #99 cat-1 conversation-only sessions', () => {
  // A consolidator that emits ONLY when it actually received conversation text,
  // so a passing test proves the conversation was read (not the observations).
  const fromConversation: Consolidator = {
    async extract(input) {
      return input.transcriptTail?.includes('AGPL')
        ? [{ kind: 'decision' as const, text: 'License is AGPL-3.0', salience: 8 }]
        : [];
    },
  };

  it('consolidates a ZERO-observation session when the hook supplies a transcript with conversation', async () => {
    await seedProject();
    // No observations appended — this is the cat-1 case.
    const transcriptPath = join(sandbox, 'conv.jsonl');
    await writeFile(
      transcriptPath,
      JSON.stringify({
        type: 'user',
        message: { content: 'we will use AGPL-3.0 for the license' },
      }) + '\n',
      'utf8',
    );

    const result = await consolidate({
      projectId,
      actor: 'test',
      transcriptPath,
      consolidator: fromConversation,
    });
    expect(result.consolidated).toBe(1);
    expect(result.observationsProcessed).toBe(0);
  });

  it('stays a NOOP when there are neither observations nor a transcript', async () => {
    await seedProject();
    const result = await consolidate({
      projectId,
      actor: 'test',
      consolidator: fromConversation,
    });
    expect(result.consolidated).toBe(0);
    // #127: a configured-but-nothing-to-do run names its backend and marks the
    // outcome 'noop' — it must NOT read as an unconfigured/no-extractor run.
    expect(result.extractor).toBe('custom');
    expect(result.backend).toBe('custom');
    expect(result.outcome).toBe('noop');
  });

  it('advances the byte watermark so a re-read with no new conversation is a NOOP', async () => {
    await seedProject();
    const transcriptPath = join(sandbox, 'conv.jsonl');
    await writeFile(
      transcriptPath,
      JSON.stringify({
        type: 'user',
        message: { content: 'we will use AGPL-3.0 for the license' },
      }) + '\n',
      'utf8',
    );

    const first = await consolidate({
      projectId,
      actor: 'test',
      transcriptPath,
      consolidator: fromConversation,
    });
    expect(first.consolidated).toBe(1);

    // Same transcript, nothing appended: the byte watermark is at EOF, so the
    // conversation read yields nothing and the boundary is a NOOP.
    const second = await consolidate({
      projectId,
      actor: 'test',
      transcriptPath,
      consolidator: fromConversation,
    });
    expect(second.consolidated).toBe(0);
    expect(second.extractor).toBe('custom');
    expect(second.backend).toBe('custom');
    expect(second.outcome).toBe('noop');
  });
});

describe('consolidate() — #127 backend/outcome reporting', () => {
  it('a rule-based no-op names rule-based as the backend (NOT "none")', async () => {
    await seedProject();
    // No observations, no transcript, no injected consolidator: the resolved
    // backend falls back to rule-based. The genuinely-degraded/unconfigured
    // signal is "rule-based", and the empty-window outcome is "noop".
    const result = await consolidate({ projectId, actor: 'test' });
    expect(result.consolidated).toBe(0);
    expect(result.extractor).toBe('rule-based');
    expect(result.backend).toBe('rule-based');
    expect(result.outcome).toBe('noop');
  });

  it('a real-work boundary reports outcome "ok" and the resolved backend', async () => {
    await seedProject();
    await appendObservation();
    const result = await consolidate({
      projectId,
      actor: 'test',
      consolidator: oneMemory,
    });
    expect(result.consolidated).toBe(1);
    expect(result.observationsProcessed).toBe(1);
    expect(result.extractor).toBe('custom');
    expect(result.backend).toBe('custom');
    expect(result.outcome).toBe('ok');
  });
});
