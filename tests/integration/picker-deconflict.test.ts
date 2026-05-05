import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadStartContext } from '../../src/services/context-service.js';
import { runClaudeHook } from '../../src/services/hook-service.js';
import { createProject } from '../../src/services/project-service.js';
import {
  SESSION_ENV_VAR,
  startSession,
} from '../../src/services/session-service.js';
import { createTask } from '../../src/services/task-service.js';
import { getSessionsDir } from '../../src/storage/path-resolver.js';

let sandbox: string;
let memorizeRoot: string;

beforeEach(async () => {
  // realpath because macOS mkdtemp returns the symlinked
  // /var/folders path while bindings store keys by canonical
  // /private/var form.
  sandbox = await realpath(await mkdtemp(join(tmpdir(), 'memorize-picker-')));
  memorizeRoot = join(sandbox, '.memorize-home');
  process.env.MEMORIZE_ROOT = memorizeRoot;
  delete process.env[SESSION_ENV_VAR];
});

afterEach(async () => {
  delete process.env.MEMORIZE_ROOT;
  delete process.env[SESSION_ENV_VAR];
  await rm(sandbox, { recursive: true, force: true });
});

// rc.2 dogfood found the auto-picker always returning the same first
// candidate task even when other active sessions had clearly claimed
// it. These tests pin the deconflict behavior end-to-end so any future
// regression to the old "first-of-list" picker fails loudly.
describe('loadStartContext picker — task deconfliction', () => {
  it('skips tasks already claimed by other active sessions and picks the first unclaimed one', async () => {
    const project = await createProject({
      title: 'duo-pane',
      rootPath: sandbox,
      summary: 'test',
    });
    const t1 = await createTask({ projectId: project.id, title: 'Task 1', actor: 'user' });
    const t2 = await createTask({ projectId: project.id, title: 'Task 2', actor: 'user' });
    const t3 = await createTask({ projectId: project.id, title: 'Task 3', actor: 'user' });

    // Session A starts and claims t1.
    delete process.env[SESSION_ENV_VAR];
    await startSession(sandbox, {
      projectId: project.id,
      taskId: t1.id,
      actor: 'claude',
    });

    // New context load (without explicit taskId, simulating session B
    // starting fresh): picker must skip t1 and return t2.
    const startup = await loadStartContext({ projectId: project.id });
    expect(startup.task?.id).toBe(t2.id);
    void t3;
  });

  it('falls back to a claimed task only when every candidate is claimed', async () => {
    const project = await createProject({
      title: 'full-house',
      rootPath: sandbox,
      summary: 'test',
    });
    const t1 = await createTask({ projectId: project.id, title: 'Task 1', actor: 'user' });
    const t2 = await createTask({ projectId: project.id, title: 'Task 2', actor: 'user' });

    delete process.env[SESSION_ENV_VAR];
    await startSession(sandbox, {
      projectId: project.id,
      taskId: t1.id,
      actor: 'claude',
    });
    delete process.env[SESSION_ENV_VAR];
    await startSession(sandbox, {
      projectId: project.id,
      taskId: t2.id,
      actor: 'codex',
    });

    // No unclaimed candidates left — picker still returns something so
    // the agent has a starting point. The renderer surfaces
    // otherActiveTasks alongside, so the agent knows it is duplicating
    // work and can decide to defer.
    const startup = await loadStartContext({ projectId: project.id });
    expect(startup.task).toBeDefined();
    expect([t1.id, t2.id]).toContain(startup.task?.id);
    expect(startup.otherActiveTasks?.length).toBeGreaterThan(0);
  });

  it('hides heartbeat-stale sessions from the picker without changing their stored status', async () => {
    // Picker-smartens (Step 1 of the picker-aware redesign): a session
    // whose lastSeenAt is older than the staleness threshold must not
    // count as a competitor for the picker, but its on-disk status
    // must stay 'active' (no abandoned/completed transition). Reaping
    // remains an explicit operation. We back-date the projection
    // directly so we can assert the filter without sleeping.
    const project = await createProject({
      title: 'stale-hidden',
      rootPath: sandbox,
      summary: 'test',
    });
    const t1 = await createTask({ projectId: project.id, title: 'Task 1', actor: 'user' });
    await createTask({ projectId: project.id, title: 'Task 2', actor: 'user' });

    delete process.env[SESSION_ENV_VAR];
    const staleSessionId = await startSession(sandbox, {
      projectId: project.id,
      taskId: t1.id,
      actor: 'claude',
    });

    const sessionFile = join(getSessionsDir(project.id), `${staleSessionId}.json`);
    const session = JSON.parse(await readFile(sessionFile, 'utf8'));
    const longAgo = '2020-01-01T00:00:00.000Z';
    await writeFile(
      sessionFile,
      JSON.stringify({ ...session, lastSeenAt: longAgo, updatedAt: longAgo }, null, 2),
      'utf8',
    );

    // Stale session is hidden → t1 looks unclaimed → picker offers it.
    const startup = await loadStartContext({ projectId: project.id });
    expect(startup.task?.id).toBe(t1.id);
    expect(startup.otherActiveTasks ?? []).toHaveLength(0);

    // But the session record on disk is unchanged — still 'active'.
    const onDisk = JSON.parse(await readFile(sessionFile, 'utf8'));
    expect(onDisk.status).toBe('active');
  });

  it('serializes parallel SessionStart hooks so each session claims a distinct task (rc.7 round-2 race)', async () => {
    // rc.7 round-2 dogfood saw two Claude SessionStart hooks fire
    // 32ms apart and BOTH pickers select the same first-unclaimed
    // task — neither hook had observed the other's session.started
    // event when its picker ran. The fix wraps the picker view +
    // startSession write in a per-project file lock; this test fires
    // four hooks in parallel and pins that they each get a different
    // task. Without the lock this fails repeatably.
    const project = await createProject({
      title: 'parallel-claim',
      rootPath: sandbox,
      summary: 'race regression',
    });
    const tasks = await Promise.all(
      [1, 2, 3, 4].map((i) =>
        createTask({
          projectId: project.id,
          title: `Task ${i}`,
          actor: 'user',
        }),
      ),
    );
    void tasks;

    // Fire 4 SessionStart hooks in parallel. Each carries a distinct
    // agentSessionId so the resume-detection path stays out of the
    // way and every call goes through the new-session claim path
    // (the one the lock protects).
    const stdinPayload = (uuid: string): string =>
      JSON.stringify({
        cwd: sandbox,
        hook_event_name: 'SessionStart',
        session_id: uuid,
      });
    const uuids = [
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      'cccccccc-cccc-cccc-cccc-cccccccccccc',
      'dddddddd-dddd-dddd-dddd-dddddddddddd',
    ];
    await Promise.all(
      uuids.map((uuid) =>
        runClaudeHook({
          eventName: 'SessionStart',
          cwd: sandbox,
          stdinPayload: stdinPayload(uuid),
        }),
      ),
    );

    const sessionFiles = await readdir(join(sandbox, '.memorize', 'sessions'));
    expect(sessionFiles).toHaveLength(4);

    const claimedTaskIds = new Set<string>();
    for (const file of sessionFiles) {
      const pointer = JSON.parse(
        await readFile(join(sandbox, '.memorize', 'sessions', file), 'utf8'),
      );
      expect(pointer.taskId).toBeDefined();
      claimedTaskIds.add(pointer.taskId);
    }
    // Four distinct claims — no two sessions share a task.
    expect(claimedTaskIds.size).toBe(4);
  });

  it('does not exclude the calling session itself when selfSessionId is passed', async () => {
    const project = await createProject({
      title: 'self-aware',
      rootPath: sandbox,
      summary: 'test',
    });
    const t1 = await createTask({ projectId: project.id, title: 'Task 1', actor: 'user' });
    await createTask({ projectId: project.id, title: 'Task 2', actor: 'user' });

    delete process.env[SESSION_ENV_VAR];
    const selfSessionId = await startSession(sandbox, {
      projectId: project.id,
      taskId: t1.id,
      actor: 'claude',
    });

    // Self-claim on t1 must not block the picker from offering t1
    // back when the caller IS that session — e.g. session resumes
    // mid-flow after a compact and re-loads its own context.
    const startup = await loadStartContext({
      projectId: project.id,
      selfSessionId,
    });
    expect(startup.task?.id).toBe(t1.id);
  });
});
