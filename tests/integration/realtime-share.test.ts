import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../src/domain/common.js';
import {
  createConsolidatedMemory,
  createObservation,
} from '../../src/domain/entities.js';
import { captureObservation } from '../../src/services/capture-service.js';
import { listOpenConflicts, rebuildProjectProjection } from '../../src/services/projection-store.js';
import {
  MAX_LIVE_OBSERVATIONS,
  buildLiveUpdate,
  composeLiveUpdate,
  deleteShareWatermark,
  normalizeFilePath,
  readShareWatermark,
  sweepOrphanShareWatermarks,
  writeShareWatermark,
} from '../../src/services/realtime-share-service.js';
import {
  SESSION_ENV_VAR,
  reapStaleSessions,
  startSession,
} from '../../src/services/session-service.js';
import { closeAll, getDb } from '../../src/storage/db.js';
import { appendEvent, readEvents } from '../../src/storage/event-store.js';

const projectId = 'proj_rt_share';
const ts = '2026-06-08T00:00:00.000Z';
const OLD_WINDOW = '2000-01-01T00:00:00.000Z';

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
      title: 'RT',
      summary: 'Realtime share test project',
      goals: [],
      status: 'active',
      rootPath: '/tmp/rt',
      activeWorkstreamIds: [],
      activeTaskIds: [],
      acceptedDecisionIds: [],
      ruleIds: [],
    } as never,
  });
  await rebuildProjectProjection(projectId);
}

function asSession(sessionId: string): void {
  process.env[SESSION_ENV_VAR] = sessionId;
}

async function captureWriteAs(
  sessionId: string,
  filePath: string,
): Promise<void> {
  asSession(sessionId);
  await captureObservation({
    projectId,
    agent: 'claude',
    cwd: sandbox,
    rawPayload: JSON.stringify({
      session_id: `agent-${sessionId}`,
      tool_name: 'Write',
      tool_input: { file_path: filePath },
    }),
  });
}

async function captureBashAs(sessionId: string, command: string): Promise<void> {
  asSession(sessionId);
  await captureObservation({
    projectId,
    agent: 'claude',
    cwd: sandbox,
    rawPayload: JSON.stringify({
      session_id: `agent-${sessionId}`,
      tool_name: 'Bash',
      tool_input: { command },
    }),
  });
}

async function applyPatchAs(
  sessionId: string,
  agent: 'claude' | 'codex',
  filePath: string,
): Promise<void> {
  asSession(sessionId);
  const patch = [
    '*** Begin Patch',
    `*** Update File: ${filePath}`,
    '@@',
    '-old',
    '+new',
    '*** End Patch',
  ].join('\n');
  await captureObservation({
    projectId,
    agent,
    cwd: sandbox,
    rawPayload: JSON.stringify({
      session_id: `agent-${sessionId}`,
      tool_name: 'apply_patch',
      tool_input: { command: patch },
    }),
  });
}

/** Append a sibling observation directly (no session-resolution dance) — for
 *  the pure buildLiveUpdate unit assertions. */
async function appendObservation(
  sessionId: string,
  filePath: string,
): Promise<string> {
  const observation = createObservation({
    projectId,
    signal: 'write-tool',
    sessionId,
    toolName: 'Write',
    summary: `Write: ${filePath}`,
    filePath,
  });
  const event = await appendEvent({
    type: 'observation.captured',
    projectId,
    scopeType: 'session',
    scopeId: sessionId,
    actor: 'claude',
    payload: observation,
  });
  await rebuildProjectProjection(projectId, { reindexSearch: false });
  return event.id;
}

async function appendGitOp(sessionId: string, command: string): Promise<string> {
  const observation = createObservation({
    projectId,
    signal: 'mutating-bash',
    sessionId,
    toolName: 'Bash',
    summary: command,
  });
  const event = await appendEvent({
    type: 'observation.captured',
    projectId,
    scopeType: 'session',
    scopeId: sessionId,
    actor: 'claude',
    payload: observation,
  });
  await rebuildProjectProjection(projectId, { reindexSearch: false });
  return event.id;
}

/** Append a memory.consolidated event directly (as the detached background
 *  consolidation child would) — for the Part B (#46) live-injection tests. */
async function appendMemory(
  sessionId: string,
  text: string,
): Promise<string> {
  const memory = createConsolidatedMemory({
    projectId,
    kind: 'progress',
    text,
    salience: 5,
    sessionId,
  });
  await appendEvent({
    type: 'memory.consolidated',
    projectId,
    scopeType: 'session',
    scopeId: sessionId,
    actor: 'claude',
    payload: memory,
  });
  await rebuildProjectProjection(projectId, { reindexSearch: false });
  return memory.id;
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-rt-'));
  process.env.MEMORIZE_ROOT = sandbox;
  delete process.env.MEMORIZE_LLM_API_KEY;
  delete process.env.MEMORIZE_LIVE_CONFLICT_EVENTS;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  delete process.env[SESSION_ENV_VAR];
  delete process.env.MEMORIZE_LIVE_CONFLICT_EVENTS;
  await rm(sandbox, { recursive: true, force: true });
});

describe('realtime-share — watermark API', () => {
  it('reads/writes/deletes a per-session watermark in the meta table', async () => {
    await seedProject();
    expect(readShareWatermark(projectId, 's1')).toBeUndefined();
    writeShareWatermark(projectId, 's1', 'evt_abc');
    expect(readShareWatermark(projectId, 's1')).toBe('evt_abc');
    writeShareWatermark(projectId, 's1', 'evt_def');
    expect(readShareWatermark(projectId, 's1')).toBe('evt_def');
    // Per-session isolation.
    writeShareWatermark(projectId, 's2', 'evt_zzz');
    expect(readShareWatermark(projectId, 's1')).toBe('evt_def');
    deleteShareWatermark(projectId, 's1');
    expect(readShareWatermark(projectId, 's1')).toBeUndefined();
    expect(readShareWatermark(projectId, 's2')).toBe('evt_zzz');
  });

  it('sweepOrphanShareWatermarks drops keys for unknown sessions only', async () => {
    await seedProject();
    writeShareWatermark(projectId, 'live1', 'e1');
    writeShareWatermark(projectId, 'dead1', 'e2');
    sweepOrphanShareWatermarks(projectId, new Set(['live1']));
    expect(readShareWatermark(projectId, 'live1')).toBe('e1');
    expect(readShareWatermark(projectId, 'dead1')).toBeUndefined();
  });
});

describe('realtime-share — buildLiveUpdate', () => {
  it('returns sibling events and filters out the calling session', async () => {
    await seedProject();
    const since = await appendObservation('A', '/repo/seed.ts');
    await appendObservation('A', '/repo/self.ts'); // self
    await appendObservation('B', '/repo/sibling.ts'); // sibling

    const update = await buildLiveUpdate({
      projectId,
      selfSessionId: 'A',
      sinceEventId: since,
      selfRecentFilePaths: new Set(),
      cwd: sandbox,
      selfRecentGitOp: false,
      gitOpWindowStartIso: OLD_WINDOW,
    });

    expect(update.hasContent).toBe(true);
    expect(update.observations).toHaveLength(1);
    expect(update.observations[0]!.sessionId).toBe('B');
    expect(update.observations[0]!.summary).toContain('/repo/sibling.ts');
  });

  it('no-ops without a self session id (cannot self-filter)', async () => {
    await seedProject();
    const since = await appendObservation('A', '/repo/seed.ts');
    await appendObservation('B', '/repo/sibling.ts');
    const update = await buildLiveUpdate({
      projectId,
      selfSessionId: undefined,
      sinceEventId: since,
      selfRecentFilePaths: new Set(),
      cwd: sandbox,
      selfRecentGitOp: false,
      gitOpWindowStartIso: OLD_WINDOW,
    });
    expect(update.hasContent).toBe(false);
    expect(update.observations).toHaveLength(0);
  });

  it('caps sibling observations at MAX_LIVE_OBSERVATIONS', async () => {
    await seedProject();
    const since = await appendObservation('A', '/repo/seed.ts');
    for (let i = 0; i < MAX_LIVE_OBSERVATIONS + 3; i += 1) {
      await appendObservation('B', `/repo/f${i}.ts`);
    }
    const update = await buildLiveUpdate({
      projectId,
      selfSessionId: 'A',
      sinceEventId: since,
      selfRecentFilePaths: new Set(),
      cwd: sandbox,
      selfRecentGitOp: false,
      gitOpWindowStartIso: OLD_WINDOW,
    });
    expect(update.observations).toHaveLength(MAX_LIVE_OBSERVATIONS);
    // Watermark covers the WHOLE window (last event), not just the kept slice.
    const events = await readEvents(projectId);
    expect(update.newWatermarkEventId).toBe(events[events.length - 1]!.id);
  });

  it('includes memory.consolidated from the SELF session (late background consolidation, #46)', async () => {
    await seedProject();
    const since = await appendObservation('A', '/repo/seed.ts');
    await appendObservation('A', '/repo/self.ts');
    // The detached background child consolidates A's own boundary window
    // AFTER the boundary — new information for the still-running session A.
    await appendMemory('A', 'Consolidated decision from my own boundary');

    const update = await buildLiveUpdate({
      projectId,
      selfSessionId: 'A',
      sinceEventId: since,
      selfRecentFilePaths: new Set(),
      cwd: sandbox,
      selfRecentGitOp: false,
      gitOpWindowStartIso: OLD_WINDOW,
    });

    expect(update.hasContent).toBe(true);
    expect(update.memories).toHaveLength(1);
    expect(update.memories[0]!.text).toBe(
      'Consolidated decision from my own boundary',
    );
    expect(update.memories[0]!.sessionId).toBe('A');
    // Raw self-observations stay filtered — only memories pass through.
    expect(update.observations).toHaveLength(0);
  });

  it('detects a file collision when a sibling touches a self-touched path', async () => {
    await seedProject();
    const since = await appendObservation('A', '/repo/seed.ts');
    await appendObservation('B', '/repo/shared.ts');
    await appendObservation('B', '/repo/shared.ts'); // duplicate path → one warning

    const update = await buildLiveUpdate({
      projectId,
      selfSessionId: 'A',
      sinceEventId: since,
      selfRecentFilePaths: new Set([
        normalizeFilePath('/repo/shared.ts', sandbox),
      ]),
      cwd: sandbox,
      selfRecentGitOp: false,
      gitOpWindowStartIso: OLD_WINDOW,
    });
    expect(update.conflicts).toHaveLength(1);
    expect(update.conflicts[0]!.filePath).toBe('/repo/shared.ts');
    expect(update.conflicts[0]!.siblingSessionId).toBe('B');
  });

  it('warns on a git collision only when self is also doing destructive git ops', async () => {
    await seedProject();
    const since = await appendObservation('A', '/repo/seed.ts');
    await appendGitOp('B', 'git worktree remove .worktrees/x');

    // self NOT doing git ops → no warning (noise guard)
    const quiet = await buildLiveUpdate({
      projectId, selfSessionId: 'A', sinceEventId: since,
      selfRecentFilePaths: new Set(), cwd: sandbox,
      selfRecentGitOp: false, gitOpWindowStartIso: OLD_WINDOW,
    });
    expect(quiet.gitOpWarnings).toHaveLength(0);

    // self IS doing git ops → warning
    const loud = await buildLiveUpdate({
      projectId, selfSessionId: 'A', sinceEventId: since,
      selfRecentFilePaths: new Set(), cwd: sandbox,
      selfRecentGitOp: true, gitOpWindowStartIso: OLD_WINDOW,
    });
    expect(loud.gitOpWarnings).toHaveLength(1);
    expect(loud.gitOpWarnings[0]!.siblingSessionId).toBe('B');
    expect(loud.gitOpWarnings[0]!.command).toContain('git worktree remove');
    expect(loud.hasContent).toBe(true);
  });

  it('#168 — warns even when the sibling git op was already delivered (watermark moved past it)', async () => {
    await seedProject();
    // B's destructive git op is DELIVERED to A on an earlier update, so A's share
    // watermark advances to it. Later A runs its OWN git op (the event after the
    // watermark that makes selfRecentGitOp true). B's op is now behind the
    // watermark — invisible to the post-watermark delta, but still in-window.
    const bGitOp = await appendGitOp('B', 'git worktree remove .worktrees/x');
    await appendGitOp('A', 'git worktree remove .worktrees/a');

    const update = await buildLiveUpdate({
      projectId, selfSessionId: 'A', sinceEventId: bGitOp,
      selfRecentFilePaths: new Set(), cwd: sandbox,
      selfRecentGitOp: true, gitOpWindowStartIso: OLD_WINDOW,
    });

    // Window-based scan still finds B's op — the old watermark-bound scan, which
    // only saw events after bGitOp (just A's own, self-filtered), would not.
    expect(update.gitOpWarnings).toHaveLength(1);
    expect(update.gitOpWarnings[0]!.siblingSessionId).toBe('B');
    expect(update.gitOpWarnings[0]!.command).toContain('git worktree remove');
  });

  it('drops sibling git ops older than the freshness window, and dedups per session', async () => {
    await seedProject();
    const since = await appendObservation('A', '/repo/seed.ts');
    await appendGitOp('B', 'git worktree remove .worktrees/x');
    await appendGitOp('B', 'git branch -D feature/x'); // same session → dedup

    // window start in the FUTURE → every sibling git op is "too old"
    const future = '2999-01-01T00:00:00.000Z';
    const stale = await buildLiveUpdate({
      projectId, selfSessionId: 'A', sinceEventId: since,
      selfRecentFilePaths: new Set(), cwd: sandbox,
      selfRecentGitOp: true, gitOpWindowStartIso: future,
    });
    expect(stale.gitOpWarnings).toHaveLength(0);

    const fresh = await buildLiveUpdate({
      projectId, selfSessionId: 'A', sinceEventId: since,
      selfRecentFilePaths: new Set(), cwd: sandbox,
      selfRecentGitOp: true, gitOpWindowStartIso: OLD_WINDOW,
    });
    expect(fresh.gitOpWarnings).toHaveLength(1); // deduped to one per session
  });
});

describe('realtime-share — composeLiveUpdate (two-session e2e)', () => {
  it('cold-starts silently, then injects sibling activity, then is idempotent', async () => {
    await seedProject();
    const sessionA = await startSession(sandbox, {
      actor: 'claude',
      projectId,
    });
    const sessionB = await startSession(sandbox, {
      actor: 'claude',
      projectId,
    });

    // A touches a file, then composes → cold start: no watermark yet, so it
    // seeds to head and stays silent.
    await captureWriteAs(sessionA, '/repo/x.ts');
    asSession(sessionA);
    const cold = await composeLiveUpdate({
      projectId,
      agent: 'claude',
      cwd: sandbox,
    });
    expect(cold).toBeUndefined();
    expect(readShareWatermark(projectId, sessionA)).toBeTruthy();

    // B does new work.
    await captureWriteAs(sessionB, '/repo/y.ts');

    // A's next tool call sees B's signal.
    asSession(sessionA);
    const injected = await composeLiveUpdate({
      projectId,
      agent: 'claude',
      cwd: sandbox,
    });
    expect(injected).toBeTruthy();
    expect(injected).toContain('/repo/y.ts');
    expect(injected).toContain('live update');
    // A must NOT see its own x.ts write echoed back.
    expect(injected).not.toContain('/repo/x.ts');

    // Idempotent: no new sibling activity → silent.
    asSession(sessionA);
    const again = await composeLiveUpdate({
      projectId,
      agent: 'claude',
      cwd: sandbox,
    });
    expect(again).toBeUndefined();
  });

  it('#62 — a delivered live-share memory bumps injection_count without a reinforcement stamp', async () => {
    await seedProject();
    const sessionA = await startSession(sandbox, {
      actor: 'claude',
      projectId,
    });

    // Cold start seeds the watermark.
    await captureWriteAs(sessionA, '/repo/x.ts');
    asSession(sessionA);
    await composeLiveUpdate({ projectId, agent: 'claude', cwd: sandbox });

    // Late background consolidation lands a memory after the boundary.
    const memoryId = await appendMemory(sessionA, 'Late boundary memory');

    asSession(sessionA);
    const injected = await composeLiveUpdate({
      projectId,
      agent: 'claude',
      cwd: sandbox,
    });
    expect(injected).toContain('Late boundary memory');

    const row = getDb(projectId)
      .prepare(
        'SELECT injection_count, last_accessed_at FROM memories WHERE id = ?',
      )
      .get(memoryId) as {
      injection_count: number;
      last_accessed_at: string | null;
    };
    expect(row.injection_count).toBe(1);
    // Observe-only: no last_accessed_at stamp — retrieval ranking unchanged.
    expect(row.last_accessed_at).toBeNull();

    // The advanced watermark prevents re-injection → no double count.
    asSession(sessionA);
    const again = await composeLiveUpdate({
      projectId,
      agent: 'claude',
      cwd: sandbox,
    });
    expect(again).toBeUndefined();
    const rowAfter = getDb(projectId)
      .prepare('SELECT injection_count FROM memories WHERE id = ?')
      .get(memoryId) as { injection_count: number };
    expect(rowAfter.injection_count).toBe(1);
  });

  it('surfaces a file-collision warning and (opt-in) promotes a conflict event', async () => {
    await seedProject();
    const sessionA = await startSession(sandbox, {
      actor: 'claude',
      projectId,
    });
    const sessionB = await startSession(sandbox, {
      actor: 'claude',
      projectId,
    });

    // A touches shared.ts and seeds its watermark.
    await captureWriteAs(sessionA, '/repo/shared.ts');
    asSession(sessionA);
    await composeLiveUpdate({ projectId, agent: 'claude', cwd: sandbox });

    // B touches the SAME file.
    await captureWriteAs(sessionB, '/repo/shared.ts');

    process.env.MEMORIZE_LIVE_CONFLICT_EVENTS = '1';
    asSession(sessionA);
    const injected = await composeLiveUpdate({
      projectId,
      agent: 'claude',
      cwd: sandbox,
    });
    expect(injected).toContain('File overlap');
    expect(injected).toContain('/repo/shared.ts');

    // Opt-in promotion appended a conflict.detected event + projection row.
    const conflictEvents = (await readEvents(projectId)).filter(
      (e) => e.type === 'conflict.detected',
    );
    expect(conflictEvents.length).toBeGreaterThan(0);
    const open = listOpenConflicts(projectId);
    expect(open.some((c) => c.fieldPath === '/repo/shared.ts')).toBe(true);
  });

  it('surfaces a destructive-git collision when both sessions touch shared git', async () => {
    await seedProject();
    const sessionA = await startSession(sandbox, { actor: 'claude', projectId });
    const sessionB = await startSession(sandbox, { actor: 'claude', projectId });

    // A does a destructive git op and seeds its watermark.
    await captureBashAs(sessionA, 'git worktree remove .worktrees/a');
    asSession(sessionA);
    await composeLiveUpdate({ projectId, agent: 'claude', cwd: sandbox });

    // B does a destructive git op too.
    await captureBashAs(sessionB, 'git worktree remove .worktrees/b');

    // A's next tool call sees the collision warning.
    asSession(sessionA);
    const injected = await composeLiveUpdate({ projectId, agent: 'claude', cwd: sandbox });
    expect(injected).toBeTruthy();
    expect(injected).toContain('Parallel destructive git activity');
    expect(injected).toContain('git worktree remove .worktrees/b');
    // A must not see its own op echoed.
    expect(injected).not.toContain('.worktrees/a');
  });

  it('stays silent when only ONE session does destructive git ops', async () => {
    await seedProject();
    const sessionA = await startSession(sandbox, { actor: 'claude', projectId });
    const sessionB = await startSession(sandbox, { actor: 'claude', projectId });

    // A is NOT doing git ops (just a file write); B is.
    await captureWriteAs(sessionA, '/repo/x.ts');
    asSession(sessionA);
    await composeLiveUpdate({ projectId, agent: 'claude', cwd: sandbox });

    await captureBashAs(sessionB, 'git worktree remove .worktrees/b');
    asSession(sessionA);
    const injected = await composeLiveUpdate({ projectId, agent: 'claude', cwd: sandbox });
    // B's git op shows as a normal sibling work signal, but NOT as a collision warning.
    if (injected) expect(injected).not.toContain('Parallel destructive git activity');
  });

  it('reap drops the per-session watermark', async () => {
    await seedProject();
    const sessionA = await startSession(sandbox, {
      actor: 'claude',
      projectId,
    });
    asSession(sessionA);
    writeShareWatermark(projectId, sessionA, 'evt_seed');
    expect(readShareWatermark(projectId, sessionA)).toBe('evt_seed');

    await reapStaleSessions(sandbox, { force: true });
    expect(readShareWatermark(projectId, sessionA)).toBeUndefined();
  });
});

describe('realtime-share — codex apply_patch symmetry', () => {
  it('a codex apply_patch edit is shared and collides with a claude write on the same file', async () => {
    await seedProject();
    const claudeA = await startSession(sandbox, {
      actor: 'claude',
      projectId,
    });
    const codexB = await startSession(sandbox, {
      actor: 'codex',
      projectId,
    });

    // Claude A edits shared.ts (Write) and seeds its watermark.
    await captureWriteAs(claudeA, '/repo/shared.ts');
    asSession(claudeA);
    await composeLiveUpdate({ projectId, agent: 'claude', cwd: sandbox });

    // Codex B edits the SAME file via apply_patch.
    await applyPatchAs(codexB, 'codex', '/repo/shared.ts');

    // Claude A's next tool call sees codex's apply_patch signal AND a
    // file-overlap warning — proving codex edits are no longer invisible.
    asSession(claudeA);
    const injected = await composeLiveUpdate({
      projectId,
      agent: 'claude',
      cwd: sandbox,
    });
    expect(injected).toBeTruthy();
    expect(injected).toContain('/repo/shared.ts');
    expect(injected).toContain('apply_patch');
    expect(injected).toContain('File overlap');
  });
});

describe('realtime-share — codex degradation', () => {
  it('composes without throwing for a codex agent and stays silent with no siblings', async () => {
    await seedProject();
    const sessionA = await startSession(sandbox, {
      actor: 'codex',
      projectId,
    });
    asSession(sessionA);
    const result = await composeLiveUpdate({
      projectId,
      agent: 'codex',
      cwd: sandbox,
    });
    // Cold start → undefined, no throw.
    expect(result).toBeUndefined();
    // Watermark seeded even on the codex path.
    expect(readShareWatermark(projectId, sessionA)).toBeTruthy();
  });
});

describe('realtime-share — getDb meta isolation sanity', () => {
  it('does not collide with the consolidation watermark key', async () => {
    await seedProject();
    writeShareWatermark(projectId, 's1', 'evt_share');
    getDb(projectId)
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('cls_consolidate_watermark', 'evt_consol')",
      )
      .run();
    expect(readShareWatermark(projectId, 's1')).toBe('evt_share');
  });
});
