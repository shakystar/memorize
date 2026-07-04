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
  runWatcherLoop,
  spawnDetachedWatcher,
  watcherLockPath,
  watcherMarkerPath,
  watcherShouldExit,
  watcherTick,
  writeInboundMarker,
} from '../../src/services/watcher-service.js';
import { getSyncFile } from '../../src/storage/path-resolver.js';
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
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(result).toEqual({ ticks: 3, exit: 'max-ticks' });
    // No sleep after the final tick — the loop exits, it does not linger.
    expect(sleeps).toEqual([17, 17]);
  });
});

describe('watcherTick', () => {
  it('reports unconfigured (and stays off the network) without sync state', async () => {
    const result = await watcherTick(PROJECT);
    expect(result).toEqual({ configured: false, pulled: 0, pushed: 0 });
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
});
