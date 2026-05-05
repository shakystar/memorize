import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SESSION_ENV_VAR,
  bumpHeartbeat,
  endSession,
  findCwdSessionByAgentId,
  getCurrentSessionId,
  getCurrentSessionTaskId,
  reapStaleSessions,
  resumeSession,
  startSession,
} from '../../src/services/session-service.js';

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-session-svc-'));
  delete process.env[SESSION_ENV_VAR];
});

afterEach(async () => {
  delete process.env[SESSION_ENV_VAR];
  await rm(sandbox, { recursive: true, force: true });
});

describe('bumpHeartbeat — telemetry must never break a command', () => {
  it('no-ops silently when no session pointer exists in cwd', async () => {
    // Fresh cwd with no .memorize directory at all. The middleware in
    // src/cli/index.ts fires bumpHeartbeat after every non-session-managing
    // command, including ones run from arbitrary directories that have
    // never been bound to a memorize project.
    await expect(bumpHeartbeat(sandbox)).resolves.toBeUndefined();
  });

  it('no-ops silently when current session has no projectId (ambient session)', async () => {
    // startSession without a projectId mints an ambient sessionId and
    // records a pointer with no projectId. bumpHeartbeat must skip
    // emitting a session.heartbeat event in that case — there is no
    // project to attribute the event to.
    const sessionId = await startSession(sandbox);
    expect(sessionId).toMatch(/^session_/);
    await expect(bumpHeartbeat(sandbox)).resolves.toBeUndefined();
  });
});

describe('multi-session per cwd — Sprint 3-5 fix', () => {
  it('writes one pointer per session under .memorize/sessions/', async () => {
    delete process.env[SESSION_ENV_VAR];
    const a = await startSession(sandbox);
    delete process.env[SESSION_ENV_VAR];
    const b = await startSession(sandbox);
    expect(a).not.toBe(b);

    const sessionsDir = join(sandbox, '.memorize', 'sessions');
    const files = await readdir(sessionsDir);
    expect(files.sort()).toEqual([`${a}.json`, `${b}.json`].sort());

    // Old single-pointer file is no longer created.
    await expect(
      readFile(join(sandbox, '.memorize', 'current-session.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('parallel ambient sessions in the same cwd do not clobber each other', async () => {
    delete process.env[SESSION_ENV_VAR];
    const a = await startSession(sandbox);
    delete process.env[SESSION_ENV_VAR];
    const b = await startSession(sandbox);

    // Reading by env var resolves to the right pointer for each session.
    process.env[SESSION_ENV_VAR] = a;
    expect(await getCurrentSessionId(sandbox)).toBe(a);
    process.env[SESSION_ENV_VAR] = b;
    expect(await getCurrentSessionId(sandbox)).toBe(b);
  });

  it('endSession removes only the resolved session pointer, leaving siblings intact', async () => {
    delete process.env[SESSION_ENV_VAR];
    const a = await startSession(sandbox);
    delete process.env[SESSION_ENV_VAR];
    const b = await startSession(sandbox);

    process.env[SESSION_ENV_VAR] = a;
    await endSession(sandbox);

    const remaining = await readdir(join(sandbox, '.memorize', 'sessions'));
    expect(remaining).toEqual([`${b}.json`]);
  });

  it('endSession without env/tty/sessionId is a no-op rather than killing the most-recent active session', async () => {
    // Regression for the rc.2 dogfood finding: Claude's Stop hook was
    // calling endSession with no env propagation and no tty match,
    // and the old most-recent fallback marked an unrelated codex
    // session as completed. After the fix endSession must silently
    // return rather than guess.
    delete process.env[SESSION_ENV_VAR];
    const a = await startSession(sandbox);
    delete process.env[SESSION_ENV_VAR];
    const b = await startSession(sandbox);
    delete process.env[SESSION_ENV_VAR];

    await endSession(sandbox);

    const remaining = await readdir(join(sandbox, '.memorize', 'sessions'));
    expect(remaining.sort()).toEqual([`${a}.json`, `${b}.json`].sort());
  });

  it('endSession honours an explicit sessionId option from a memorize-aware caller', async () => {
    // The API surface allows callers that already know the memorize
    // session id (scripts, tests, future tooling) to bypass env/tty
    // disambiguation. Note: hook handlers MUST NOT use this path with
    // agent-supplied session ids — Claude/Codex payloads speak their
    // own ID space, not memorize's. See the rc.4 Gap D hook fix.
    delete process.env[SESSION_ENV_VAR];
    const a = await startSession(sandbox);
    delete process.env[SESSION_ENV_VAR];
    const b = await startSession(sandbox);
    delete process.env[SESSION_ENV_VAR];

    await endSession(sandbox, { sessionId: a });

    const remaining = await readdir(join(sandbox, '.memorize', 'sessions'));
    expect(remaining).toEqual([`${b}.json`]);
  });

  it('getCurrentSessionTaskId returns the taskId the session claimed at startSession (Gap A)', async () => {
    // Regression for the rc.3 dogfood Gap A: PostCompact / Stop hooks
    // were attributing checkpoints to project.activeTaskIds[0] instead
    // of the task this session itself claimed. The hook handlers now
    // call getCurrentSessionTaskId first and only fall back to the
    // project-level guess if the session never claimed anything.
    // (The real-project event-log path is exercised in the
    // picker-deconflict integration test; here we only need the
    // pointer plumbing.)
    delete process.env[SESSION_ENV_VAR];
    const sessionId = await startSession(sandbox, {
      taskId: 'task_claimed_by_self',
      actor: 'claude',
    });
    process.env[SESSION_ENV_VAR] = sessionId;

    expect(await getCurrentSessionTaskId(sandbox)).toBe('task_claimed_by_self');
  });

  it('getCurrentSessionTaskId returns undefined when the session has no claimed task', async () => {
    delete process.env[SESSION_ENV_VAR];
    const sessionId = await startSession(sandbox, { actor: 'claude' });
    process.env[SESSION_ENV_VAR] = sessionId;

    expect(await getCurrentSessionTaskId(sandbox)).toBeUndefined();
  });

  it('migrates a legacy current-session.json into the sessions/ directory and deletes the original', async () => {
    // Simulate a project that was last touched by rc.0/rc.1 — a single
    // pointer file at the legacy location, no sessions/ directory.
    await mkdir(join(sandbox, '.memorize'), { recursive: true });
    const legacyPayload = {
      sessionId: 'session_legacy_xx',
      startedAt: '2026-04-29T10:00:00.000Z',
      startedBy: 'claude',
    };
    await writeFile(
      join(sandbox, '.memorize', 'current-session.json'),
      JSON.stringify(legacyPayload, null, 2),
      'utf8',
    );

    // Any session-service entry point triggers the migration. Use
    // getCurrentSessionId so we do not mint a new ambient id first.
    const resolved = await getCurrentSessionId(sandbox);
    expect(resolved).toBe('session_legacy_xx');

    await expect(
      readFile(join(sandbox, '.memorize', 'current-session.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const migrated = await readFile(
      join(sandbox, '.memorize', 'sessions', 'session_legacy_xx.json'),
      'utf8',
    );
    expect(JSON.parse(migrated)).toMatchObject({
      sessionId: 'session_legacy_xx',
      startedBy: 'claude',
    });
  });
});

describe('resumeSession — picker-smartens / resume seamless', () => {
  it('returns false (no-op) when the cwd pointer is gone', async () => {
    // No sessions/ dir, no pointer. Caller (SessionStart) must fall
    // back to startSession in that case.
    const ok = await resumeSession(sandbox, 'session_does_not_exist');
    expect(ok).toBe(false);
  });

  it('reuses the existing pointer and bumps agentPid without a new session.started', async () => {
    delete process.env[SESSION_ENV_VAR];
    const sessionId = await startSession(sandbox, {
      actor: 'claude',
      agentSessionId: 'agent_uuid_42',
      agentPid: 1111,
    });

    // findCwdSessionByAgentId resolves the pointer back from the
    // agent UUID — same lookup the SessionStart handler does on
    // resume.
    const found = await findCwdSessionByAgentId(sandbox, 'agent_uuid_42');
    expect(found?.sessionId).toBe(sessionId);

    delete process.env[SESSION_ENV_VAR];
    const ok = await resumeSession(sandbox, sessionId, { agentPid: 2222 });
    expect(ok).toBe(true);

    // Pointer still single, agentPid bumped to the new value.
    const remaining = await readdir(join(sandbox, '.memorize', 'sessions'));
    expect(remaining).toEqual([`${sessionId}.json`]);
    const pointer = JSON.parse(
      await readFile(join(sandbox, '.memorize', 'sessions', `${sessionId}.json`), 'utf8'),
    );
    expect(pointer.agentPid).toBe(2222);
    expect(pointer.agentSessionId).toBe('agent_uuid_42');

    // Env var seeded so the rest of this hook subprocess attributes
    // CLI calls back to this session.
    expect(process.env[SESSION_ENV_VAR]).toBe(sessionId);
  });
});

describe('reapStaleSessions — β lifecycle ownership', () => {
  it('does not reap a freshly started session (within the staleness threshold)', async () => {
    delete process.env[SESSION_ENV_VAR];
    const a = await startSession(sandbox);
    const result = await reapStaleSessions(sandbox);
    expect(result.reapedSessionIds).toEqual([]);
    // Pointer still on disk for the live session.
    const remaining = await readdir(join(sandbox, '.memorize', 'sessions'));
    expect(remaining).toEqual([`${a}.json`]);
  });

  it('with force: true reaps every cwd pointer regardless of age', async () => {
    delete process.env[SESSION_ENV_VAR];
    const a = await startSession(sandbox);
    delete process.env[SESSION_ENV_VAR];
    const b = await startSession(sandbox);
    const result = await reapStaleSessions(sandbox, { force: true });
    expect(result.reapedSessionIds.sort()).toEqual([a, b].sort());
    const remaining = await readdir(join(sandbox, '.memorize', 'sessions')).catch(
      () => [] as string[],
    );
    expect(remaining).toEqual([]);
  });

  it('startSession does NOT auto-reap stale pointers — reap must be explicit (Step 2 of picker-aware redesign)', async () => {
    // Step 2 removed the auto-reap-on-start sweep. Even when every
    // existing pointer is past the staleness threshold
    // (MEMORIZE_STALE_SESSION_MS=0), starting a new session must
    // leave them on disk. The picker hides them from its view (Step
    // 1) without status mutation; only `memorize session reap`
    // transitions them to abandoned. This protects users who
    // routinely `claude --resume` a long-lived role session — their
    // pointer must outlive an unrelated startSession in the same cwd.
    process.env.MEMORIZE_STALE_SESSION_MS = '0';
    try {
      delete process.env[SESSION_ENV_VAR];
      const a = await startSession(sandbox);
      delete process.env[SESSION_ENV_VAR];
      const b = await startSession(sandbox);
      delete process.env[SESSION_ENV_VAR];
      const c = await startSession(sandbox);
      const remaining = await readdir(join(sandbox, '.memorize', 'sessions'));
      expect(remaining.sort()).toEqual([`${a}.json`, `${b}.json`, `${c}.json`].sort());
    } finally {
      delete process.env.MEMORIZE_STALE_SESSION_MS;
    }
  });
});
