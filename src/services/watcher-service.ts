import { spawn } from 'node:child_process';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { nowIso } from '../domain/common.js';
import { isPersonalStoreId } from '../domain/identity/personal-store.js';
import { listCwdPointers } from '../storage/cwd-session-store.js';
import { readEventsSince, readHeadEventId } from '../storage/event-store.js';
import { getProjectRoot } from '../storage/path-resolver.js';
import { autoPull, autoPush } from './auto-sync-service.js';
import { readSyncState } from './project-service.js';
import { getSession } from './projection-store.js';
import { staleThresholdMs } from './session-service.js';

/**
 * SoT-042/043 — the session-bound WATCHER: a detached process, spawned by
 * SessionStart, that gives sync a mid-session cadence ("watcher sync").
 * Each tick is a watermark-gated pull (SoT-042's receiver half) plus a
 * watermark-gated push (SoT-043) — so inbound work lands within one poll
 * interval and local work propagates without waiting for a boundary.
 *
 * Lifetime is session-bound (the Gradle-daemon model, SoT-042): the loop
 * exits on its own once no session pointer in the spawning cwd shows
 * activity within the heartbeat staleness threshold — no OS service, no
 * boot autostart, crash recovery is "the next SessionStart respawns".
 * Single instance per project is enforced by a pid-carrying lockfile.
 *
 * Per-turn hooks stay network-free (the rc.0-4 rule): the agent's only
 * mid-session awareness surface is the local marker file this process
 * writes after a pull that actually inserted events.
 */

/** Suite-wide off-switch (vitest.config.ts) — mirrors CONSOLIDATE_INLINE. */
export const WATCHER_DISABLED_ENV_VAR = 'MEMORIZE_WATCHER_DISABLED';
export const WATCHER_POLL_MS_ENV_VAR = 'MEMORIZE_WATCHER_POLL_MS';
/** Test-only bound on loop iterations; unset = run until session-idle. */
export const WATCHER_MAX_TICKS_ENV_VAR = 'MEMORIZE_WATCHER_MAX_TICKS';

/** SoT-042: ~30s keeps end-to-end delegation latency ≈ send push (0s) +
 *  one poll interval + the next tool boundary, at negligible Hub load. */
const DEFAULT_POLL_MS = 30_000;

function pollMsFromEnv(): number {
  const raw = process.env[WATCHER_POLL_MS_ENV_VAR];
  if (raw === undefined || raw === '') return DEFAULT_POLL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_POLL_MS;
}

function maxTicksFromEnv(): number | undefined {
  const raw = process.env[WATCHER_MAX_TICKS_ENV_VAR];
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

// --- single-instance lock ---------------------------------------------------

interface WatcherLockInfo {
  pid: number;
  startedAt: string;
}

export function watcherLockPath(projectId: string): string {
  return path.join(getProjectRoot(projectId), 'locks', 'watcher.lock');
}

/** `kill(pid, 0)` probes liveness without signaling; EPERM means "alive but
 *  not ours", which still counts as a live holder. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readWatcherLock(
  projectId: string,
): Promise<WatcherLockInfo | undefined> {
  try {
    const raw = await readFile(watcherLockPath(projectId), 'utf8');
    const parsed = JSON.parse(raw) as WatcherLockInfo;
    return typeof parsed.pid === 'number' ? parsed : undefined;
  } catch {
    return undefined; // absent or unparseable — both read as "no live holder"
  }
}

/**
 * Atomic acquire (`wx` create) with stale-holder takeover: a lock whose pid
 * is dead is unlinked and re-contended once. Two racers both seeing a dead
 * holder is safe — both unlink (one ENOENTs), and `wx` lets exactly one win
 * the re-create. Returns false when a LIVE holder exists (the SoT-042
 * "two SessionStarts race, one watcher" guarantee).
 */
export async function acquireWatcherLock(
  projectId: string,
  pid: number = process.pid,
): Promise<boolean> {
  const lockPath = watcherLockPath(projectId);
  await mkdir(path.dirname(lockPath), { recursive: true });
  const body = JSON.stringify({ pid, startedAt: nowIso() } satisfies WatcherLockInfo);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(lockPath, body, { flag: 'wx' });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      const holder = await readWatcherLock(projectId);
      if (holder && isPidAlive(holder.pid)) return false;
      try {
        await unlink(lockPath);
      } catch {
        // A sibling racer already unlinked it — the retry contends the create.
      }
    }
  }
  return false;
}

/** Releases only our own lock — a takeover by a newer watcher (possible if
 *  this process was judged dead, e.g. after a long suspend) must not have
 *  its lock deleted out from under it. */
export async function releaseWatcherLock(
  projectId: string,
  pid: number = process.pid,
): Promise<void> {
  const holder = await readWatcherLock(projectId);
  if (holder?.pid !== pid) return;
  try {
    await unlink(watcherLockPath(projectId));
  } catch {
    // Already gone — release is best-effort.
  }
}

// --- inbound marker ----------------------------------------------------------

/** The network-free per-turn surface (SoT-042): hooks may stat/read this
 *  file, never poll the Hub. Overwritten per delivery; consumers key on
 *  mtime. (Pulled event CONTENT already reaches the agent through the
 *  existing PostToolUse live-update channel, which reads the local DB delta
 *  — the marker exists for cheap "something arrived" detection, e.g. the
 *  slice-2 delegation inbox surfacing.) */
export function watcherMarkerPath(projectId: string): string {
  return path.join(getProjectRoot(projectId), 'watcher', 'inbound.json');
}

export async function writeInboundMarker(
  projectId: string,
  pulled: number,
): Promise<void> {
  const markerPath = watcherMarkerPath(projectId);
  await mkdir(path.dirname(markerPath), { recursive: true });
  await writeFile(markerPath, JSON.stringify({ at: nowIso(), pulled }), 'utf8');
}

// --- loop --------------------------------------------------------------------

export interface WatcherTickResult {
  /** false = sync no longer configured; the loop has no job and exits. */
  configured: boolean;
  pulled: number;
  pushed: number;
}

/**
 * One watcher-sync tick: watermark pull, marker on delivery, then push —
 * but only when the local delta past the persisted push watermark contains
 * a SELF-lane event. Pulled foreign events advance the head too, and while
 * pushing them back is harmless (the Hub's union dedups by event id), the
 * gate keeps an idle tick at exactly ONE network round trip: the pull probe.
 * The gate is a local DB read; with no push watermark yet it degrades to a
 * full scan, which self-heals as soon as the first push lands.
 */
export async function watcherTick(projectId: string): Promise<WatcherTickResult> {
  const state = await readSyncState(projectId);
  if (!state?.syncEnabled || !state.syncTransport) {
    return { configured: false, pulled: 0, pushed: 0 };
  }

  const pull = await autoPull(projectId);
  const pulled = pull.pulled ?? 0;
  if (pulled > 0) await writeInboundMarker(projectId, pulled);

  const head = await readHeadEventId(projectId);
  if (!head) return { configured: true, pulled, pushed: 0 };
  // Re-read: the pull above may itself have advanced lastPulledEventId state.
  const watermark = (await readSyncState(projectId))?.lastPushedEventId;
  if (head === watermark) return { configured: true, pulled, pushed: 0 };
  const delta = await readEventsSince(projectId, watermark);
  const hasSelfLaneEvents = delta.some(
    (event) => !event.sourceProjectId || event.sourceProjectId === projectId,
  );
  if (!hasSelfLaneEvents) return { configured: true, pulled, pushed: 0 };

  const push = await autoPush(projectId);
  return { configured: true, pulled, pushed: push.pushed ?? 0 };
}

/**
 * Session-idle exit test (SoT-042: "exit once the last heartbeat is old").
 * The watcher stays alive while ANY pointer in the spawning cwd is anchored
 * to a live session: not paused/completed/abandoned, and with activity
 * (projection lastSeenAt when available, else pointer startedAt) inside the
 * same staleness threshold the reap sweep uses — one knob, one meaning of
 * "this session is gone". A paused session (SessionEnd fired) stops
 * anchoring immediately, so the watcher dies within one poll of the agent
 * exiting; `claude --resume` respawns it via SessionStart.
 */
export async function watcherShouldExit(
  cwd: string,
  projectId: string,
): Promise<boolean> {
  const pointers = await listCwdPointers(cwd);
  const now = Date.now();
  const threshold = staleThresholdMs();
  for (const pointer of pointers) {
    if (pointer.projectId && pointer.projectId !== projectId) continue;
    let lastActivityMs = Date.parse(pointer.startedAt);
    let status: string | undefined;
    if (pointer.projectId) {
      try {
        const session = getSession(pointer.projectId, pointer.sessionId);
        status = session?.status;
        if (session?.lastSeenAt) {
          lastActivityMs = Date.parse(session.lastSeenAt);
        }
      } catch {
        // Projection unavailable — judge by pointer.startedAt alone.
      }
    }
    if (status === 'paused' || status === 'completed' || status === 'abandoned') {
      continue;
    }
    if (now - lastActivityMs < threshold) return false;
  }
  return true;
}

export interface WatcherLoopResult {
  ticks: number;
  exit: 'idle-sessions' | 'not-configured' | 'max-ticks';
}

/** Injectable seams for tests; production callers pass nothing. */
export interface WatcherLoopDeps {
  tick?: typeof watcherTick;
  shouldExit?: typeof watcherShouldExit;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function runWatcherLoop(
  options: { cwd: string; projectId: string },
  deps: WatcherLoopDeps = {},
): Promise<WatcherLoopResult> {
  const tick = deps.tick ?? watcherTick;
  const shouldExit = deps.shouldExit ?? watcherShouldExit;
  const sleep = deps.sleep ?? defaultSleep;
  const pollMs = pollMsFromEnv();
  const maxTicks = maxTicksFromEnv();

  let ticks = 0;
  for (;;) {
    if (await shouldExit(options.cwd, options.projectId)) {
      return { ticks, exit: 'idle-sessions' };
    }
    const result = await tick(options.projectId);
    ticks += 1;
    if (!result.configured) return { ticks, exit: 'not-configured' };
    if (maxTicks !== undefined && ticks >= maxTicks) {
      return { ticks, exit: 'max-ticks' };
    }
    await sleep(pollMs);
  }
}

// --- spawn (SessionStart wiring) ----------------------------------------------

interface DetachedChildLike {
  unref(): void;
}

export type WatcherSpawnImpl = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    detached: boolean;
    stdio: 'ignore';
    windowsHide: boolean;
  },
) => DetachedChildLike;

/**
 * SessionStart's side: spawn `memorize watcher run` detached (same child
 * discipline as consolidate: windowsHide, unref, never throws into the
 * hook). The parent's holder check is a cheap fast-path only — the
 * AUTHORITATIVE single-instance decision is the child's atomic lock
 * acquire, so a check/spawn race between two SessionStarts still ends
 * with one watcher. No-spawn when sync is not configured: a watcher with
 * no transport has no job. Returns whether a child was spawned.
 */
export async function spawnDetachedWatcher(
  ctx: { projectId: string; cwd: string },
  spawnImpl: WatcherSpawnImpl = spawn,
): Promise<boolean> {
  if (process.env[WATCHER_DISABLED_ENV_VAR] === '1') return false;
  if (isPersonalStoreId(ctx.projectId)) return false;
  try {
    const state = await readSyncState(ctx.projectId);
    if (!state?.syncEnabled || !state.syncTransport) return false;
    const holder = await readWatcherLock(ctx.projectId);
    if (holder && isPidAlive(holder.pid)) return false;
    const cliEntry = fileURLToPath(new URL('../cli/index.js', import.meta.url));
    const child = spawnImpl(process.execPath, [cliEntry, 'watcher', 'run'], {
      cwd: ctx.cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `WARN: watcher not started (${message}); sync degrades to boundary cadence\n`,
    );
    return false;
  }
}
