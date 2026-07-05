import { spawn } from 'node:child_process';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { nowIso } from '../domain/common.js';
import { isPersonalStoreId } from '../domain/identity/personal-store.js';
import { listCwdPointers } from '../storage/cwd-session-store.js';
import { readEventsSince, readHeadEventId } from '../storage/event-store.js';
import { writeJson } from '../storage/fs-utils.js';
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
  /** Important-A lease: refreshed every tick by renewWatcherLock. Falls back
   *  to startedAt for a lock written before this field existed, or by a
   *  process that dies before its first renew. */
  renewedAt?: string;
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

/** Important-A: a lock is stale — regardless of pid liveness — once its
 *  lease (renewedAt, falling back to startedAt for a lock never renewed)
 *  is older than 2x the poll interval. This is what reclaims a watcher
 *  that crashed without releasing its lock on a Windows host where the pid
 *  has since been reused by an unrelated process: pid-liveness alone would
 *  read that lock as "alive" forever and no watcher would ever run again. */
function isLeaseStale(holder: WatcherLockInfo): boolean {
  const renewedAtMs = Date.parse(holder.renewedAt ?? holder.startedAt);
  if (Number.isNaN(renewedAtMs)) return true; // corrupt timestamp — treat as stale
  return Date.now() - renewedAtMs > 2 * pollMsFromEnv();
}

/**
 * Atomic acquire (`wx` create) with stale-holder takeover: a lock whose pid
 * is dead, OR whose lease has expired (Important-A — see isLeaseStale), is
 * unlinked and re-contended once. Two racers both seeing a stale holder is
 * safe — both unlink (one ENOENTs), and `wx` lets exactly one win the
 * re-create. Returns false when a LIVE, in-lease holder exists (the
 * SoT-042 "two SessionStarts race, one watcher" guarantee).
 */
export async function acquireWatcherLock(
  projectId: string,
  pid: number = process.pid,
): Promise<boolean> {
  const lockPath = watcherLockPath(projectId);
  await mkdir(path.dirname(lockPath), { recursive: true });
  const now = nowIso();
  const body = JSON.stringify(
    { pid, startedAt: now, renewedAt: now } satisfies WatcherLockInfo,
  );
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(lockPath, body, { flag: 'wx' });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      const holder = await readWatcherLock(projectId);
      const stale = !holder || isLeaseStale(holder) || !isPidAlive(holder.pid);
      if (!stale) return false;
      try {
        await unlink(lockPath);
      } catch {
        // A sibling racer already unlinked it — the retry contends the create.
      }
    }
  }
  return false;
}

/** Important-A per-tick lease renewal: rewrites the lock file with a fresh
 *  `renewedAt`, and reports whether we still hold it. Combines the
 *  self-verification and the lease-refresh the finding asks for into one
 *  call: if a racer's stale-takeover already double-acquired (pid mismatch),
 *  this returns false so runWatcherLoop exits within one tick instead of
 *  continuing to poll a project another watcher now owns. */
export async function renewWatcherLock(
  projectId: string,
  pid: number = process.pid,
): Promise<boolean> {
  const holder = await readWatcherLock(projectId);
  if (!holder || holder.pid !== pid) return false;
  const renewed: WatcherLockInfo = {
    pid,
    startedAt: holder.startedAt,
    renewedAt: nowIso(),
  };
  // Minor fix: atomic rewrite (writeJson → write-file-atomic), not a raw
  // writeFile — a contender reading this file mid-write would see a
  // truncated body, parse it as "no holder", and evict a perfectly live
  // watcher (a transient false eviction). Only this REWRITE of an
  // already-held lock uses the atomic path; acquireWatcherLock's first
  // creation still needs plain `wx` exclusive-create semantics, which
  // writeJson does not offer. The JSON shape (pid/startedAt/renewedAt) is
  // unchanged, so readWatcherLock's JSON.parse keeps working either way.
  await writeJson(watcherLockPath(projectId), renewed);
  return true;
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
  // Minor fix: atomic write (fs-utils' writeJson → write-file-atomic) instead
  // of a raw writeFile — a hook reading this file mid-write must never see a
  // truncated/partial JSON body.
  await writeJson(watcherMarkerPath(projectId), { at: nowIso(), pulled });
}

// --- loop --------------------------------------------------------------------

export interface WatcherTickResult {
  /** false = sync no longer configured; the loop has no job and exits. */
  configured: boolean;
  pulled: number;
  pushed: number;
}

/** Injectable seams for tests (mirrors WatcherLoopDeps); production callers
 *  pass nothing. */
export interface WatcherTickDeps {
  pull?: typeof autoPull;
  push?: typeof autoPush;
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
export async function watcherTick(
  projectId: string,
  deps: WatcherTickDeps = {},
): Promise<WatcherTickResult> {
  const pull = deps.pull ?? autoPull;
  const push = deps.push ?? autoPush;
  const state = await readSyncState(projectId);
  // Minor fix: align with auto-sync-service's isConfigured — a project with
  // syncEnabled+syncTransport but no remoteProjectId yet (half-configured)
  // has no remote to talk to. Without this check the watcher polls forever
  // instead of exiting 'not-configured'.
  if (!state?.syncEnabled || !state.syncTransport || !state.remoteProjectId) {
    return { configured: false, pulled: 0, pushed: 0 };
  }

  const pullResult = await pull(projectId);
  const pulled = pullResult.pulled ?? 0;
  if (pulled > 0) await writeInboundMarker(projectId, pulled);

  const head = await readHeadEventId(projectId);
  if (!head) return { configured: true, pulled, pushed: 0 };
  // Re-read: the pull above may itself have advanced lastPulledEventId state.
  const watermark = (await readSyncState(projectId))?.lastPushedEventId;
  if (head === watermark) return { configured: true, pulled, pushed: 0 };
  const delta = await readEventsSince(projectId, watermark);
  // Critical-2b: exclude sync.state.updated — same filter buildPushPayload
  // applies to the actual push payload. Without it, a pull's own watermark
  // bookkeeping event (or, pre-fix, its per-tick 'syncing'/'idle' churn)
  // always reads as a self-lane delta, so the gate never gates — every
  // foreign-only pull still triggers a (wasted) push attempt.
  const hasSelfLaneEvents = delta.some(
    (event) =>
      event.type !== 'sync.state.updated' &&
      (!event.sourceProjectId || event.sourceProjectId === projectId),
  );
  if (!hasSelfLaneEvents) return { configured: true, pulled, pushed: 0 };

  const pushResult = await push(projectId);
  return { configured: true, pulled, pushed: pushResult.pushed ?? 0 };
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
export interface WatcherShouldExitOpts {
  /** Critical-1b startup grace: when set together with graceMs, a cwd with
   *  ZERO session pointers is treated as alive (not exit) until this many ms
   *  have elapsed since startedAtMs. Defense in depth for the spawn-ordering
   *  race (hook-service now spawns the watcher AFTER the session pointer
   *  write, but this covers any future caller that gets the order wrong, or
   *  a filesystem write that lands late under contention): a watcher child
   *  that boots before its own session's pointer is written must not read
   *  that transient zero-pointer state as "no session ever existed" and
   *  exit at birth with nothing left to respawn it. Pointers that DO exist
   *  (even stale ones) are judged normally — the grace only overrides the
   *  "nothing here yet" case. */
  startedAtMs?: number;
  graceMs?: number;
}

export async function watcherShouldExit(
  cwd: string,
  projectId: string,
  opts: WatcherShouldExitOpts = {},
): Promise<boolean> {
  const pointers = await listCwdPointers(cwd);
  if (
    pointers.length === 0 &&
    opts.startedAtMs !== undefined &&
    opts.graceMs !== undefined &&
    Date.now() - opts.startedAtMs < opts.graceMs
  ) {
    return false;
  }
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
  exit:
    | 'idle-sessions'
    | 'not-configured'
    | 'max-ticks'
    | 'lock-lost'
    | 'tick-failures';
}

/** Injectable seams for tests; production callers pass nothing. */
export interface WatcherLoopDeps {
  tick?: typeof watcherTick;
  shouldExit?: typeof watcherShouldExit;
  sleep?: (ms: number) => Promise<void>;
  /** Important-A: per-tick lease self-verify + renew. Defaults to
   *  renewWatcherLock(projectId) (own pid). Returns false when we no
   *  longer hold the lock. */
  renewLock?: (projectId: string) => Promise<boolean>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Important-B: a tick that throws (FS/DB hiccup — Windows AV EBUSY/EPERM,
 *  SQLITE_BUSY) must not kill the daemon for the rest of the session; only
 *  sustained failure should. */
const MAX_CONSECUTIVE_TICK_FAILURES = 5;

export async function runWatcherLoop(
  options: { cwd: string; projectId: string },
  deps: WatcherLoopDeps = {},
): Promise<WatcherLoopResult> {
  const tick = deps.tick ?? watcherTick;
  const shouldExit = deps.shouldExit ?? watcherShouldExit;
  const sleep = deps.sleep ?? defaultSleep;
  const renewLock = deps.renewLock ?? renewWatcherLock;
  const pollMs = pollMsFromEnv();
  const maxTicks = maxTicksFromEnv();
  // Critical-1b: the grace window is exactly one poll interval, timed from
  // loop start — see WatcherShouldExitOpts.
  const loopStartedAt = Date.now();

  let ticks = 0;
  let consecutiveFailures = 0;
  for (;;) {
    // Important-B: shouldExit, the Important-A lease renewal, AND the tick
    // are ALL wrapped in one try/catch sharing consecutiveFailures. A
    // transient FS throw from ANY of the three (Windows AV EBUSY/EPERM,
    // SQLITE_BUSY — the renew write is a plain writeJson call, no more
    // exempt from those than the tick's own FS/DB calls) must not kill the
    // daemon outright; only sustained failure should. A `return` from inside
    // this try (idle-sessions / lock-lost / not-configured / max-ticks) does
    // NOT run the catch — only a THROW does — so the lock-lost and
    // idle-sessions exits below stay immediate, un-retried signals; only
    // genuine exceptions go through the failure counter.
    let result: WatcherTickResult;
    try {
      if (
        await shouldExit(options.cwd, options.projectId, {
          startedAtMs: loopStartedAt,
          graceMs: pollMs,
        })
      ) {
        return { ticks, exit: 'idle-sessions' };
      }

      // Important-A: re-verify + renew our lease BEFORE doing any sync work
      // this tick. A racer that judged us dead and took over stale (the
      // double-acquire the finding describes), or a foreign pid that reused
      // ours (Windows PID reuse after a crash), both show up here as "not us
      // anymore" — exit immediately instead of continuing to poll a project
      // another watcher now owns. Self-heals a double-acquire within one
      // tick. This is a returned false, NOT a throw, from a healthy renew —
      // it must keep exiting 'lock-lost' immediately rather than being
      // folded into the failure counter below.
      if (!(await renewLock(options.projectId))) {
        process.stderr.write(
          `WARN: watcher lock-lost for ${options.projectId}; exiting\n`,
        );
        return { ticks, exit: 'lock-lost' };
      }

      result = await tick(options.projectId);
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `WARN: watcher iteration failed (${consecutiveFailures}/${MAX_CONSECUTIVE_TICK_FAILURES}): ${message}\n`,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_TICK_FAILURES) {
        return { ticks, exit: 'tick-failures' };
      }
      await sleep(pollMs);
      continue;
    }

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
    // Important-A fast-path fix: pid-liveness ALONE is not enough here. This
    // check is only a cheap optimization — acquireWatcherLock's atomic `wx`
    // create + stale-takeover is the authoritative decision — but if it reads
    // a lease-stale holder as "alive" (Windows PID reuse after a crash: the
    // dead watcher's pid gets recycled by an unrelated long-lived process),
    // it returns false and no child is ever spawned to run the atomic
    // reclaim. A stale lease must fall through to spawn regardless of pid
    // liveness so the child gets a chance to reclaim it.
    if (holder && !isLeaseStale(holder) && isPidAlive(holder.pid)) return false;
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
