import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SESSION_ENV_VAR,
  bumpHeartbeat,
  endSession,
  getCurrentSessionId,
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

  it('endSession honours an explicit sessionId option (Claude Stop hook payload path)', async () => {
    delete process.env[SESSION_ENV_VAR];
    const a = await startSession(sandbox);
    delete process.env[SESSION_ENV_VAR];
    const b = await startSession(sandbox);
    delete process.env[SESSION_ENV_VAR];

    // Hook payload arrives carrying its own session_id. endSession
    // must use it directly and bypass the env/tty disambiguation that
    // would otherwise pick the wrong pointer.
    await endSession(sandbox, { sessionId: a });

    const remaining = await readdir(join(sandbox, '.memorize', 'sessions'));
    expect(remaining).toEqual([`${b}.json`]);
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
