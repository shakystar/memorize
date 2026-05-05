import fs from 'node:fs/promises';
import path from 'node:path';

import { isEnoent } from './fs-utils.js';

/**
 * Lightweight per-project advisory file lock used to serialize
 * critical sections like SessionStart's pick-then-claim window.
 *
 * Why a file lock at all: the rc.7 round-2 dogfood saw two Claude
 * sessions starting 32ms apart both claim the same task — neither
 * picker's `loadStartContext` saw the OTHER session's `session.started`
 * event yet, so both selected the same first-unclaimed candidate.
 * The hole isn't in the picker, it's in the read-then-write ordering
 * across two parallel hook subprocesses. A small lock that wraps
 * "read picker view → write the new pointer + event" closes that
 * window without changing the picker's logic.
 *
 * Implementation notes:
 *   - O_EXCL create on a tiny lockfile (`<lockDir>/<name>.lock`).
 *     The file body holds `{ pid, acquiredAt }` purely so a stale
 *     leak is identifiable; the OS-level exclusion is what enforces
 *     mutual exclusion.
 *   - On EEXIST, retry with a 50ms back-off up to `holdTimeoutMs`
 *     (default 5s). SessionStart should finish in milliseconds, so
 *     5s of contention almost certainly means a previous holder
 *     crashed without cleanup.
 *   - After `holdTimeoutMs`, force-acquire by deleting the orphan.
 *     We trade a tiny risk of double-entry (vanishingly small for a
 *     5s window on a sub-second critical section) for guaranteed
 *     forward progress. Without this, a single crashed hook run
 *     would deadlock every future SessionStart in the cwd.
 *   - Release deletes the lockfile. Errors during release are
 *     swallowed (the worst case is a stale-acquire on the next
 *     entry, which the staleness path handles).
 */

export interface AcquireOptions {
  /** Total time to wait for a held lock before force-reclaiming. */
  holdTimeoutMs?: number;
  /** Per-attempt sleep when the lock is currently held. */
  retryIntervalMs?: number;
}

const DEFAULT_HOLD_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_INTERVAL_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface LockBody {
  pid: number;
  acquiredAt: string;
}

async function tryCreate(lockPath: string): Promise<boolean> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  try {
    const body: LockBody = { pid: process.pid, acquiredAt: new Date().toISOString() };
    await fs.writeFile(lockPath, JSON.stringify(body), { flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

async function forceUnlink(lockPath: string): Promise<void> {
  try {
    await fs.unlink(lockPath);
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}

/**
 * Acquires the named file lock under `lockDir`, runs `body`, and
 * releases the lock — even if `body` throws. Returns whatever `body`
 * returns. Holders timing out past `holdTimeoutMs` are reclaimed.
 */
export async function withFileLock<T>(
  lockDir: string,
  name: string,
  body: () => Promise<T>,
  options: AcquireOptions = {},
): Promise<T> {
  const lockPath = path.join(lockDir, `${name}.lock`);
  const holdTimeoutMs = options.holdTimeoutMs ?? DEFAULT_HOLD_TIMEOUT_MS;
  const retryMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;

  const deadline = Date.now() + holdTimeoutMs;
  while (true) {
    if (await tryCreate(lockPath)) break;
    if (Date.now() >= deadline) {
      // Force-reclaim — see module doc for the rationale.
      await forceUnlink(lockPath);
      if (await tryCreate(lockPath)) break;
      // Lost the race against another reclaimer; loop a couple more
      // times before giving up. Should be extremely rare.
      if (Date.now() >= deadline + holdTimeoutMs) {
        throw new Error(
          `withFileLock: could not acquire ${lockPath} after ${holdTimeoutMs * 2}ms`,
        );
      }
    }
    await sleep(retryMs);
  }

  try {
    return await body();
  } finally {
    await forceUnlink(lockPath);
  }
}
