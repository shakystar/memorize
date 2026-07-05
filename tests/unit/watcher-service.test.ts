import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  WATCHER_DISABLED_ENV_VAR,
  WATCHER_MAX_TICKS_ENV_VAR,
  WATCHER_POLL_MS_ENV_VAR,
  acquireWatcherLock,
  isPidAlive,
  releaseWatcherLock,
  renewWatcherLock,
  runWatcherLoop,
  spawnDetachedWatcher,
  watcherLockPath,
  watcherMarkerPath,
  watcherShouldExit,
  watcherTick,
  writeInboundMarker,
} from '../../src/services/watcher-service.js';
import { createFileSyncTransport } from '../../src/adapters/sync-transport-file.js';
import { createProject } from '../../src/services/project-service.js';
import { updateSyncState } from '../../src/services/sync-service.js';
import { createTask } from '../../src/services/task-service.js';
import { getSyncFile } from '../../src/storage/path-resolver.js';
import { readEvents } from '../../src/storage/event-store.js';
import { closeAll } from '../../src/storage/db.js';

const PROJECT = 'proj_watcher_test';

let sandbox: string;

/** A pid that is genuinely dead: spawn a no-op node child and wait it out. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.on('exit', () => resolve()));
  return pid;
}

async function writeSyncState(): Promise<void> {
  const syncFile = getSyncFile(PROJECT);
  await mkdir(join(syncFile, '..'), { recursive: true });
  await writeFile(
    syncFile,
    JSON.stringify({
      syncEnabled: true,
      remoteProjectId: 'wsp_watcher_test',
      syncTransport: { type: 'file', location: join(sandbox, 'remote') },
    }),
    'utf8',
  );
}

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), 'memorize-watcher-')));
  process.env.MEMORIZE_ROOT = join(sandbox, '.memorize-home');
  delete process.env[WATCHER_DISABLED_ENV_VAR];
  delete process.env[WATCHER_POLL_MS_ENV_VAR];
  delete process.env[WATCHER_MAX_TICKS_ENV_VAR];
  delete process.env.MEMORIZE_STALE_SESSION_MS;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  delete process.env[WATCHER_DISABLED_ENV_VAR];
  delete process.env[WATCHER_POLL_MS_ENV_VAR];
  delete process.env[WATCHER_MAX_TICKS_ENV_VAR];
  delete process.env.MEMORIZE_STALE_SESSION_MS;
  await rm(sandbox, { recursive: true, force: true });
});

describe('watcher lock', () => {
  it('acquires, blocks a second acquire while the holder lives, releases', async () => {
    expect(await acquireWatcherLock(PROJECT)).toBe(true);
    await expect(stat(watcherLockPath(PROJECT))).resolves.toBeTruthy();
    // Same live pid re-contends and must lose: single instance per project.
    expect(await acquireWatcherLock(PROJECT, process.pid)).toBe(false);
    await releaseWatcherLock(PROJECT);
    await expect(stat(watcherLockPath(PROJECT))).rejects.toThrow();
  });

  it('takes over a lock whose holder pid is dead', async () => {
    const stale = await deadPid();
    expect(isPidAlive(stale)).toBe(false);
    await mkdir(join(watcherLockPath(PROJECT), '..'), { recursive: true });
    await writeFile(
      watcherLockPath(PROJECT),
      JSON.stringify({ pid: stale, startedAt: new Date().toISOString() }),
      'utf8',
    );
    expect(await acquireWatcherLock(PROJECT)).toBe(true);
    const holder = JSON.parse(
      await readFile(watcherLockPath(PROJECT), 'utf8'),
    ) as { pid: number };
    expect(holder.pid).toBe(process.pid);
  });

  it('treats an unparseable lock as stale', async () => {
    await mkdir(join(watcherLockPath(PROJECT), '..'), { recursive: true });
    await writeFile(watcherLockPath(PROJECT), 'not-json', 'utf8');
    expect(await acquireWatcherLock(PROJECT)).toBe(true);
  });

  it('does not release a lock owned by someone else', async () => {
    expect(await acquireWatcherLock(PROJECT, process.pid)).toBe(true);
    await releaseWatcherLock(PROJECT, process.pid + 1);
    await expect(stat(watcherLockPath(PROJECT))).resolves.toBeTruthy();
  });

  it('treats a lease older than 2x the poll interval as stale even with a live pid (Important-A)', async () => {
    process.env[WATCHER_POLL_MS_ENV_VAR] = '10';
    await mkdir(join(watcherLockPath(PROJECT), '..'), { recursive: true });
    const longAgo = new Date(Date.now() - 60_000).toISOString();
    // The holder pid is OUR OWN process — genuinely alive — so pid-liveness
    // alone would refuse the takeover. Only the expired lease should let a
    // new contender in; this is what reclaims a watcher that crashed on a
    // host where its pid has since been reused (Windows).
    await writeFile(
      watcherLockPath(PROJECT),
      JSON.stringify({ pid: process.pid, startedAt: longAgo, renewedAt: longAgo }),
      'utf8',
    );
    expect(await acquireWatcherLock(PROJECT, process.pid + 1)).toBe(true);
  });

  it('renewWatcherLock refreshes renewedAt while we still hold the lock', async () => {
    await acquireWatcherLock(PROJECT, process.pid);
    const before = JSON.parse(
      await readFile(watcherLockPath(PROJECT), 'utf8'),
    ) as { renewedAt?: string };
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await renewWatcherLock(PROJECT, process.pid)).toBe(true);
    const after = JSON.parse(
      await readFile(watcherLockPath(PROJECT), 'utf8'),
    ) as { renewedAt?: string };
    expect(Date.parse(after.renewedAt!)).toBeGreaterThan(Date.parse(before.renewedAt!));
  });

  it('renewWatcherLock reports false once another pid holds the lock', async () => {
    await acquireWatcherLock(PROJECT, process.pid);
    await writeFile(
      watcherLockPath(PROJECT),
      JSON.stringify({
        pid: process.pid + 12345,
        startedAt: new Date().toISOString(),
        renewedAt: new Date().toISOString(),
      }),
      'utf8',
    );
    expect(await renewWatcherLock(PROJECT, process.pid)).toBe(false);
  });
});

describe('watcherShouldExit', () => {
  it('exits when the cwd has no session pointers at all', async () => {
    expect(await watcherShouldExit(sandbox, PROJECT)).toBe(true);
  });

  it('stays alive while a fresh pointer anchors the cwd', async () => {
    const sessionsDir = join(sandbox, '.memorize', 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      join(sessionsDir, 'session_fresh.json'),
      JSON.stringify({
        sessionId: 'session_fresh',
        startedAt: new Date().toISOString(),
        startedBy: 'claude',
      }),
      'utf8',
    );
    expect(await watcherShouldExit(sandbox, PROJECT)).toBe(false);
    // Threshold 0 turns the same pointer stale immediately.
    process.env.MEMORIZE_STALE_SESSION_MS = '0';
    expect(await watcherShouldExit(sandbox, PROJECT)).toBe(true);
  });

  it('ignores pointers bound to a different project', async () => {
    const sessionsDir = join(sandbox, '.memorize', 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      join(sessionsDir, 'session_other.json'),
      JSON.stringify({
        sessionId: 'session_other',
        startedAt: new Date().toISOString(),
        startedBy: 'claude',
        projectId: 'proj_someone_else',
      }),
      'utf8',
    );
    expect(await watcherShouldExit(sandbox, PROJECT)).toBe(true);
  });
});

describe('runWatcherLoop', () => {
  it('exits before the first tick when no session anchors the cwd', async () => {
    let ticks = 0;
    const result = await runWatcherLoop(
      { cwd: sandbox, projectId: PROJECT },
      {
        shouldExit: async () => true,
        tick: async () => {
          ticks += 1;
          return { configured: true, pulled: 0, pushed: 0 };
        },
      },
    );
    expect(result).toEqual({ ticks: 0, exit: 'idle-sessions' });
    expect(ticks).toBe(0);
  });

  it('stops when sync becomes unconfigured mid-flight', async () => {
    const result = await runWatcherLoop(
      { cwd: sandbox, projectId: PROJECT },
      {
        shouldExit: async () => false,
        tick: async () => ({ configured: false, pulled: 0, pushed: 0 }),
        // Important-A seam: stub out lease self-verification — this test is
        // exercising the configured/not-configured exit path in isolation,
        // not lock ownership (no lock was ever acquired for PROJECT here).
        renewLock: async () => true,
      },
    );
    expect(result).toEqual({ ticks: 1, exit: 'not-configured' });
  });

  it('honors the max-ticks bound and sleeps the poll interval between ticks', async () => {
    process.env[WATCHER_MAX_TICKS_ENV_VAR] = '3';
    process.env[WATCHER_POLL_MS_ENV_VAR] = '17';
    const sleeps: number[] = [];
    const result = await runWatcherLoop(
      { cwd: sandbox, projectId: PROJECT },
      {
        shouldExit: async () => false,
        tick: async () => ({ configured: true, pulled: 0, pushed: 0 }),
        renewLock: async () => true,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(result).toEqual({ ticks: 3, exit: 'max-ticks' });
    // No sleep after the final tick — the loop exits, it does not linger.
    expect(sleeps).toEqual([17, 17]);
  });

  it('grace: does not exit before the first poll interval when no session pointer exists yet (Critical-1b, spawn-ordering race defense)', async () => {
    // Uses the REAL default shouldExit (watcherShouldExit) — no pointer file
    // exists anywhere for this cwd/project, which pre-fix is indistinguishable
    // from "the session ended" and would exit at ticks:0 before ever ticking.
    process.env[WATCHER_POLL_MS_ENV_VAR] = '5000';
    process.env[WATCHER_MAX_TICKS_ENV_VAR] = '1';
    let ticks = 0;
    const result = await runWatcherLoop(
      { cwd: sandbox, projectId: PROJECT },
      {
        tick: async () => {
          ticks += 1;
          return { configured: true, pulled: 0, pushed: 0 };
        },
        renewLock: async () => true,
        sleep: async () => {},
      },
    );
    expect(ticks).toBe(1);
    expect(result).toEqual({ ticks: 1, exit: 'max-ticks' });
  });

  it('exits lock-lost when the lock is stolen by a different pid mid-loop (Important-A)', async () => {
    await acquireWatcherLock(PROJECT, process.pid);
    let ticks = 0;
    const result = await runWatcherLoop(
      { cwd: sandbox, projectId: PROJECT },
      {
        shouldExit: async () => false,
        tick: async () => {
          ticks += 1;
          if (ticks === 1) {
            // Simulate a racer's stale-takeover mid-loop: the lock now
            // belongs to a different pid.
            await writeFile(
              watcherLockPath(PROJECT),
              JSON.stringify({
                pid: process.pid + 999_999,
                startedAt: new Date().toISOString(),
                renewedAt: new Date().toISOString(),
              }),
              'utf8',
            );
          }
          return { configured: true, pulled: 0, pushed: 0 };
        },
        sleep: async () => {},
      },
    );
    expect(result).toEqual({ ticks: 1, exit: 'lock-lost' });
  });

  it('contains a throwing tick: N-1 failures then a success keep the loop alive (Important-B)', async () => {
    process.env[WATCHER_MAX_TICKS_ENV_VAR] = '1';
    let calls = 0;
    const result = await runWatcherLoop(
      { cwd: sandbox, projectId: PROJECT },
      {
        shouldExit: async () => false,
        renewLock: async () => true,
        sleep: async () => {},
        tick: async () => {
          calls += 1;
          if (calls < 4) throw new Error(`boom ${calls}`);
          return { configured: true, pulled: 0, pushed: 0 };
        },
      },
    );
    expect(calls).toBe(4);
    expect(result).toEqual({ ticks: 1, exit: 'max-ticks' });
  });

  it('exits tick-failures after 5 CONSECUTIVE throws (Important-B)', async () => {
    let calls = 0;
    const result = await runWatcherLoop(
      { cwd: sandbox, projectId: PROJECT },
      {
        shouldExit: async () => false,
        renewLock: async () => true,
        sleep: async () => {},
        tick: async () => {
          calls += 1;
          throw new Error(`boom ${calls}`);
        },
      },
    );
    expect(calls).toBe(5);
    expect(result).toEqual({ ticks: 0, exit: 'tick-failures' });
  });

  it('contains a THROWING renewLock in the shared failure counter: 5 consecutive throws exit tick-failures without ever calling tick (Round-2 Important)', async () => {
    let renewCalls = 0;
    let tickCalls = 0;
    const result = await runWatcherLoop(
      { cwd: sandbox, projectId: PROJECT },
      {
        shouldExit: async () => false,
        sleep: async () => {},
        renewLock: async () => {
          renewCalls += 1;
          throw new Error(`renew boom ${renewCalls}`);
        },
        tick: async () => {
          tickCalls += 1;
          return { configured: true, pulled: 0, pushed: 0 };
        },
      },
    );
    expect(renewCalls).toBe(5);
    expect(tickCalls).toBe(0);
    expect(result).toEqual({ ticks: 0, exit: 'tick-failures' });
  });

  it('a THROWING renew followed by a real lock-lost (false, not a throw) exits lock-lost immediately — it is not folded into the failure counter (Round-2 Important)', async () => {
    let renewCalls = 0;
    const result = await runWatcherLoop(
      { cwd: sandbox, projectId: PROJECT },
      {
        shouldExit: async () => false,
        sleep: async () => {},
        renewLock: async () => {
          renewCalls += 1;
          if (renewCalls === 1) throw new Error('transient renew hiccup');
          return false; // genuine lock-lost signal — must exit immediately
        },
        tick: async () => ({ configured: true, pulled: 0, pushed: 0 }),
      },
    );
    // One throw (counted, retried), then a clean "not us anymore" — exits
    // lock-lost on the very next iteration, well before the 5-throw ceiling.
    expect(renewCalls).toBe(2);
    expect(result).toEqual({ ticks: 0, exit: 'lock-lost' });
  });
});

describe('watcherTick', () => {
  it('reports unconfigured (and stays off the network) without sync state', async () => {
    const result = await watcherTick(PROJECT);
    expect(result).toEqual({ configured: false, pulled: 0, pushed: 0 });
  });

  it('reports not-configured for a half-configured project (syncEnabled+transport, no remoteProjectId)', async () => {
    // Minor fix: align with auto-sync-service's isConfigured. Without a
    // remoteProjectId there is no remote to talk to — pre-fix this read as
    // configured:true and polled forever with nothing to do.
    const project = await createProject({ title: 'Half-configured', rootPath: sandbox });
    await updateSyncState(project.id, {
      syncEnabled: true,
      syncTransport: { type: 'file', location: join(sandbox, 'remote') },
    });
    const result = await watcherTick(project.id);
    expect(result).toEqual({ configured: false, pulled: 0, pushed: 0 });
  });

  it('gate (Critical-2b): skips the push call when the only delta past watermark is sync.state.updated bookkeeping', async () => {
    const project = await createProject({ title: 'Gate test', rootPath: sandbox });
    await updateSyncState(project.id, {
      remoteProjectId: project.id,
      syncEnabled: true,
      syncTransport: { type: 'file', location: join(sandbox, 'remote') },
    });
    // Converge the watermark first (baseline push of the project's own
    // creation events) so the scenario below starts from a clean slate.
    await watcherTick(project.id, { pull: async () => ({ ran: true, pulled: 0 }) });

    // Simulate exactly what a real pull's watermark write produces: a
    // sync.state.updated event past the push watermark, with no other new
    // self-lane work. (updateSyncState always appends one — the same
    // mechanism applyPullResponse uses for lastPulledEventId.)
    await updateSyncState(project.id, { lastSyncAt: new Date().toISOString() });

    let pushCalls = 0;
    const result = await watcherTick(project.id, {
      pull: async () => ({ ran: true, pulled: 0 }),
      push: async () => {
        pushCalls += 1;
        return { ran: true, pushed: 1 };
      },
    });
    expect(pushCalls).toBe(0);
    expect(result.pushed).toBe(0);
  });

  it('gate: still pushes when a real self-lane event is past the watermark', async () => {
    const project = await createProject({ title: 'Gate test 2', rootPath: sandbox });
    await updateSyncState(project.id, {
      remoteProjectId: project.id,
      syncEnabled: true,
      syncTransport: { type: 'file', location: join(sandbox, 'remote') },
    });
    await watcherTick(project.id, { pull: async () => ({ ran: true, pulled: 0 }) });
    await createTask({ projectId: project.id, title: 'Local work', actor: 'user' });

    let pushCalls = 0;
    const result = await watcherTick(project.id, {
      pull: async () => ({ ran: true, pulled: 0 }),
      push: async () => {
        pushCalls += 1;
        return { ran: true, pushed: 1 };
      },
    });
    expect(pushCalls).toBe(1);
    expect(result.pushed).toBe(1);
  });
});

describe('watcherTick — real transport, end-to-end (SoT-043)', () => {
  it('pulls foreign events with a marker, gates a foreign-only delta, and pushes real self work', async () => {
    const remote = join(sandbox, 'remote');
    const project = await createProject({ title: 'Watcher E2E', rootPath: sandbox });
    await updateSyncState(project.id, {
      remoteProjectId: project.id,
      syncEnabled: true,
      syncTransport: { type: 'file', location: remote },
    });
    const transport = createFileSyncTransport(remote);

    // Baseline: converge the project's own creation events to the remote so
    // the scenario below starts from a caught-up watermark.
    await watcherTick(project.id);
    await rm(watcherMarkerPath(project.id), { force: true }).catch(() => {});

    // 1. Seed the remote with a FOREIGN event directly over the real
    //    transport (bypassing pushProject, which would stamp our own
    //    projectId as sourceProjectId) — simulates a sibling contributor's
    //    event landing in the shared union lane.
    const foreignEvent = {
      id: 'evt_foreign_1',
      schemaVersion: '1.0.0',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      type: 'task.created' as const,
      projectId: project.id,
      scopeType: 'task' as const,
      scopeId: 'task_foreign_1',
      actor: 'remote-user',
      sourceProjectId: 'proj_foreign_other',
      payload: { id: 'task_foreign_1', title: 'Foreign task' } as never,
    };
    await transport.push({
      projectId: project.id,
      remoteProjectId: project.id,
      events: [foreignEvent],
    });

    const tick1 = await watcherTick(project.id);
    expect(tick1.pulled).toBe(1);
    expect(tick1.pushed).toBe(0); // gate: the only new delta is foreign
    const marker1 = JSON.parse(
      await readFile(watcherMarkerPath(project.id), 'utf8'),
    ) as { pulled: number };
    expect(marker1.pulled).toBe(1);
    const afterTick1 = await readEvents(project.id);
    expect(afterTick1.some((e) => e.id === 'evt_foreign_1')).toBe(true);

    // 2. Empty remote (nothing new) → tick → NO new marker.
    await rm(watcherMarkerPath(project.id), { force: true });
    const tick2 = await watcherTick(project.id);
    expect(tick2.pulled).toBe(0);
    await expect(stat(watcherMarkerPath(project.id))).rejects.toThrow();

    // 3. A genuine self event → tick → push happens, remote gains it.
    await createTask({ projectId: project.id, title: 'Local work', actor: 'user' });
    const tick3 = await watcherTick(project.id);
    expect(tick3.pushed).toBeGreaterThan(0);
    const remoteAfterPush = await transport.pull({
      projectId: project.id,
      remoteProjectId: project.id,
    });
    expect(
      remoteAfterPush.events.some((e) => e.scopeType === 'task' && e.actor === 'user'),
    ).toBe(true);

    // 4. Foreign-only delta after pull → tick → no push (gate).
    await transport.push({
      projectId: project.id,
      remoteProjectId: project.id,
      events: [
        {
          ...foreignEvent,
          id: 'evt_foreign_2',
          scopeId: 'task_foreign_2',
          payload: { id: 'task_foreign_2', title: 'Foreign task 2' } as never,
        },
      ],
    });
    const tick4 = await watcherTick(project.id);
    expect(tick4.pulled).toBe(1);
    expect(tick4.pushed).toBe(0);
  });
});

describe('inbound marker', () => {
  it('writes a stat-able marker with the pulled count', async () => {
    await writeInboundMarker(PROJECT, 4);
    const marker = JSON.parse(
      await readFile(watcherMarkerPath(PROJECT), 'utf8'),
    ) as { at: string; pulled: number };
    expect(marker.pulled).toBe(4);
    expect(Date.parse(marker.at)).not.toBeNaN();
  });
});

describe('spawnDetachedWatcher', () => {
  const spawnedArgs: string[][] = [];
  const fakeSpawn = (_command: string, args: string[]) => {
    spawnedArgs.push(args);
    return { unref: () => {} };
  };

  beforeEach(() => {
    spawnedArgs.length = 0;
  });

  it('does not spawn when the kill switch is set', async () => {
    process.env[WATCHER_DISABLED_ENV_VAR] = '1';
    await writeSyncState();
    expect(
      await spawnDetachedWatcher({ projectId: PROJECT, cwd: sandbox }, fakeSpawn),
    ).toBe(false);
    expect(spawnedArgs).toHaveLength(0);
  });

  it('does not spawn without a configured sync transport', async () => {
    expect(
      await spawnDetachedWatcher({ projectId: PROJECT, cwd: sandbox }, fakeSpawn),
    ).toBe(false);
    expect(spawnedArgs).toHaveLength(0);
  });

  it('spawns `watcher run` when sync is configured and no live holder exists', async () => {
    await writeSyncState();
    expect(
      await spawnDetachedWatcher({ projectId: PROJECT, cwd: sandbox }, fakeSpawn),
    ).toBe(true);
    expect(spawnedArgs).toHaveLength(1);
    expect(spawnedArgs[0]!.slice(-2)).toEqual(['watcher', 'run']);
  });

  it('skips the spawn when a live watcher already holds the lock', async () => {
    await writeSyncState();
    await acquireWatcherLock(PROJECT, process.pid);
    expect(
      await spawnDetachedWatcher({ projectId: PROJECT, cwd: sandbox }, fakeSpawn),
    ).toBe(false);
    expect(spawnedArgs).toHaveLength(0);
  });

  it('spawns even when the holder pid is alive, if its lease has gone stale (Round-2 Important — PID-reuse reclaim)', async () => {
    // The holder is OUR OWN process (genuinely alive), but its lease is far
    // older than 2x the poll interval. Pre-fix, isPidAlive alone made the
    // fast-path read this as "alive" forever — which is exactly what
    // happens after a crash + Windows PID reuse by an unrelated long-lived
    // process: no watcher would ever be spawned again. The fast-path must
    // fall through to spawn so the child's atomic acquire can reclaim it.
    await writeSyncState();
    process.env[WATCHER_POLL_MS_ENV_VAR] = '10';
    const longAgo = new Date(Date.now() - 60_000).toISOString();
    await mkdir(join(watcherLockPath(PROJECT), '..'), { recursive: true });
    await writeFile(
      watcherLockPath(PROJECT),
      JSON.stringify({ pid: process.pid, startedAt: longAgo, renewedAt: longAgo }),
      'utf8',
    );
    expect(
      await spawnDetachedWatcher({ projectId: PROJECT, cwd: sandbox }, fakeSpawn),
    ).toBe(true);
    expect(spawnedArgs).toHaveLength(1);
  });
});
