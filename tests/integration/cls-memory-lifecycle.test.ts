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
  buildLifecycleEvidenceReport,
  consolidate,
  readLastConsolidateAttempt,
} from '../../src/services/consolidate-service.js';
import { SEMANTIC_CONTRADICTION_REASON_PREFIX } from '../../src/services/contradiction-service.js';
import {
  reinforceInjectedMemories,
  retrieveMemoryContext,
} from '../../src/services/memory-retrieval-service.js';
import {
  buildMemoryBehaviorReport,
  listMemoryLifecycle,
} from '../../src/services/memory-telemetry-service.js';
import {
  bumpMemoryInjections,
  listRecentObservations,
  listValidMemories,
  rebuildProjectProjection,
} from '../../src/services/projection-store.js';
import { searchProject } from '../../src/services/search-service.js';
import { closeAll, getDb } from '../../src/storage/db.js';
import {
  SESSION_ENV_VAR,
  writeCwdPointer,
} from '../../src/storage/cwd-session-store.js';
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

function postToolUsePayload(
  toolName: string,
  input: object,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    session_id: 'agent-uuid-1',
    tool_name: toolName,
    tool_input: input,
    ...extra,
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

  it('#108: recovers the owning session from the agent session_id when env/pid/tty miss', async () => {
    await seedProject();
    // env/pid/tty resolution can't reach the session (the hook process is not
    // a pid-descendant and SESSION_ENV_VAR is unset) — exactly the Windows
    // PostToolUse case that produced NULL session_id observations.
    delete process.env[SESSION_ENV_VAR];
    await writeCwdPointer(sandbox, {
      sessionId: 'sess-real-1',
      startedAt: ts,
      projectId,
      agentSessionId: 'agent-uuid-1',
    });

    const captured = await captureWrite('/repo/src/recovered.ts');

    // The observation is attributed to the real memorize session, not dropped
    // anonymously onto the project scope.
    expect(captured?.sessionId).toBe('sess-real-1');
    const event = (await readEvents(projectId)).find(
      (e) => e.type === 'observation.captured',
    );
    expect(event?.scopeId).toBe('sess-real-1');
  });

  it('#108/#109: unknown session falls back to a per-transcript scope, not projectId', async () => {
    await seedProject();
    delete process.env[SESSION_ENV_VAR];
    // No cwd pointer to recover from, but the payload carries a transcript
    // path — distinct conversations must NOT collapse onto the project scope.
    const captured = await captureObservation({
      projectId,
      agent: 'claude',
      cwd: sandbox,
      rawPayload: postToolUsePayload(
        'Write',
        { file_path: '/repo/src/orphan.ts' },
        { session_id: 'no-such-agent', transcript_path: '/tmp/conv-A.jsonl' },
      ),
    });
    expect(captured?.sessionId).toBeUndefined();

    const event = (await readEvents(projectId)).find(
      (e) => e.type === 'observation.captured',
    );
    expect(event?.scopeId).toBe('transcript:conv-A.jsonl');
    expect(event?.scopeId).not.toBe(projectId);
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

  it('persists #57 lifecycle evidence through consolidate → projection rebuild, and reports it', async () => {
    await seedProject();
    await captureWrite('/repo/src/evidence.ts');

    const evidence: Consolidator = {
      async extract() {
        return [
          {
            kind: 'progress' as const,
            text: 'Gate: run verify:full before merge',
            salience: 9,
            obsoleteWhen: 'when the merge happens',
            kindMisfit: true,
            kindMisfitReason: 'standing constraint, not progress',
            supersedesNote: 'replaces the earlier informal gate note',
            tags: ['constraint', 'gate'],
          },
        ];
      },
    };
    await consolidate({ projectId, actor: 'test', consolidator: evidence });

    const assertEvidence = () => {
      const memory = listValidMemories(projectId)[0]!.memory;
      expect(memory.obsoleteWhen).toBe('when the merge happens');
      expect(memory.kindMisfit).toBe(true);
      expect(memory.kindMisfitReason).toBe('standing constraint, not progress');
      expect(memory.supersedesNote).toBe(
        'replaces the earlier informal gate note',
      );
      expect(memory.tags).toEqual(['constraint', 'gate']);
    };
    assertEvidence();
    // The fields live in the memory.consolidated event payload, so a full
    // replay (the same path sync/import takes) must reproduce them.
    await rebuildProjectProjection(projectId);
    assertEvidence();

    const report = buildLifecycleEvidenceReport(projectId);
    expect(report.memories).toBe(1);
    expect(report.byKind.progress).toEqual({
      count: 1,
      withObsoleteWhen: 1,
      kindMisfit: 1,
      tags: { constraint: 1, gate: 1 },
    });
    expect(report.obsoleteWhen).toEqual([
      { kind: 'progress', condition: 'when the merge happens' },
    ]);
    expect(report.kindMisfitReasons).toEqual([
      {
        kind: 'progress',
        reason: 'standing constraint, not progress',
        text: 'Gate: run verify:full before merge',
      },
    ]);
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

  it('#62 — per-memory lifecycle rows and the kind x behavior report', async () => {
    await seedProject();
    await captureWrite('/repo/src/a.ts');
    const seedDecision: Consolidator = {
      async extract() {
        return [{ kind: 'decision' as const, text: 'Use sqlite', salience: 8 }];
      },
    };
    await consolidate({ projectId, actor: 'test', consolidator: seedDecision });
    const oldMemory = listValidMemories(projectId)[0]!.memory;

    // Supersede it with a contradiction-marked reason (what the semantic
    // detector writes) so the telemetry classifies it as contradicted.
    await captureWrite('/repo/src/b.ts');
    const contradicting: Consolidator = {
      async extract() {
        return [
          {
            kind: 'decision' as const,
            text: 'Use postgres',
            salience: 8,
            supersedesMemoryId: oldMemory.id,
            supersedeReason: `${SEMANTIC_CONTRADICTION_REASON_PREFIX}database engine`,
          },
        ];
      },
    };
    await consolidate({ projectId, actor: 'test', consolidator: contradicting });
    const newMemory = listValidMemories(projectId)[0]!.memory;

    // Mid-session live-share injection: counter only, NO reinforcement stamp
    // (telemetry must not change retrieval ranking).
    bumpMemoryInjections(projectId, [newMemory.id]);

    const rows = await listMemoryLifecycle(projectId);
    const oldRow = rows.find((row) => row.id === oldMemory.id)!;
    expect(oldRow.supersededBy).toBe(newMemory.id);
    expect(oldRow.contradicted).toBe(true);
    expect(oldRow.supersededAt).toBeTruthy();
    expect(oldRow.ageAtInvalidationDays).toBeGreaterThanOrEqual(0);
    const newRow = rows.find((row) => row.id === newMemory.id)!;
    expect(newRow.injectionCount).toBe(1);
    expect(newRow.lastAccessedAt).toBeUndefined();
    expect(newRow.contradicted).toBe(false);
    expect(newRow.invalidAt).toBeUndefined();

    const report = await buildMemoryBehaviorReport(projectId);
    expect(report.memories).toBe(2);
    expect(report.byKind.decision).toMatchObject({
      count: 2,
      injectedMemories: 1,
      totalInjections: 1,
      superseded: 1,
      contradicted: 1,
      deduped: 0,
    });
    expect(report.byKind.decision!.ageAtInvalidationDays).toHaveLength(1);
  });

  it('retrieves ranked memories + observation tail, reinforces, and carry-over survives rebuild', async () => {
    await seedProject();
    await captureWrite('/repo/src/a.ts');
    await consolidate({ projectId, actor: 'test' });

    const retrieved = retrieveMemoryContext(projectId);
    expect(retrieved.memories.length).toBeGreaterThan(0);
    expect(retrieved.observations.length).toBeGreaterThan(0);

    // Reinforcement stamps last_accessed_at on the projection only — and
    // counts the injection (#62 telemetry rides the same statement).
    reinforceInjectedMemories(projectId, retrieved.memories);
    const memoryId = retrieved.memories[0]!.memory.id;
    const accessState = () =>
      getDb(projectId)
        .prepare(
          'SELECT last_accessed_at, injection_count FROM memories WHERE id = ?',
        )
        .get(memoryId) as {
        last_accessed_at: string | null;
        injection_count: number;
      };
    expect(accessState().last_accessed_at).toBeTruthy();
    expect(accessState().injection_count).toBe(1);
    const stateBefore = accessState();

    // Routine rebuild (the every-write path) must NOT lose the stamp (⑤)
    // nor the injection counter (#62).
    await rebuildProjectProjection(projectId);
    expect(accessState()).toEqual(stateBefore);

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
      // #51: the PostCompact boundary recorded its attempt with its label.
      const attempt = readLastConsolidateAttempt(projectDirs[0]!);
      expect(attempt?.boundary).toBe('post-compact');
      expect(attempt?.outcome).toBe('ok');
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
