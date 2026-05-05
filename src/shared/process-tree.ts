import { spawnSync } from 'node:child_process';

/**
 * Returns `true` when `pid` corresponds to a live process visible to
 * this user. We use signal 0 — the kernel performs the existence /
 * permission check without delivering anything. EPERM means the
 * process exists but is owned by another user, which still counts as
 * alive for our purposes (the agent is running, even if not as us).
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}

interface PsRow {
  pid: number;
  ppid: number;
  comm: string;
}

function readPsRow(pid: number): PsRow | undefined {
  // `comm` truncates to 16 chars on macOS/Linux but that's enough to
  // distinguish 'claude' / 'codex' from 'node' / 'sh'. Avoid `command`
  // (full argv) — it pulls in unbounded data and hits BSD vs GNU
  // formatting quirks.
  const result = spawnSync(
    'ps',
    ['-o', 'pid=,ppid=,comm=', '-p', String(pid)],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) return undefined;
  const line = result.stdout.trim().split('\n')[0];
  if (!line) return undefined;
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
  if (!match) return undefined;
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    comm: (match[3] ?? '').trim(),
  };
}

/**
 * Walks up the process tree from `startPid` looking for an ancestor
 * whose `comm` matches one of `targetNames`. Returns the matching pid,
 * or `undefined` if we hit pid 1 / a missing row first. Capped at
 * `maxHops` to bound runtime in pathological process forests.
 *
 * Used by SessionStart to capture the agent's pid (Claude / Codex
 * parent) so later picker calls can do PID-liveness checks. Pure
 * best-effort: any failure returns undefined and the caller falls
 * back to heartbeat-only liveness.
 */
export function findAncestorPidByName(params: {
  startPid: number;
  targetNames: readonly string[];
  maxHops?: number;
}): number | undefined {
  const { startPid, targetNames } = params;
  const maxHops = params.maxHops ?? 12;
  let cursor = startPid;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const row = readPsRow(cursor);
    if (!row) return undefined;
    const lowerComm = row.comm.toLowerCase();
    if (targetNames.some((name) => lowerComm.includes(name.toLowerCase()))) {
      return row.pid;
    }
    if (row.ppid <= 1) return undefined;
    cursor = row.ppid;
  }
  return undefined;
}

/**
 * Returns the chain of pids visited by walking up from `startPid`,
 * inclusive of `startPid` itself. Stops at pid 1, missing rows, or
 * `maxHops`. Used by session-context to check whether any ancestor
 * pid matches a known agent pid stamped on a cwd pointer — the only
 * reliable way to attribute a memorize CLI subprocess back to the
 * codex session that spawned it (codex doesn't expose its session id
 * via env the way Claude does through CLAUDE_ENV_FILE).
 */
export function walkAncestorPids(
  startPid: number,
  maxHops = 12,
): number[] {
  const out: number[] = [];
  let cursor = startPid;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const row = readPsRow(cursor);
    if (!row) return out;
    out.push(row.pid);
    if (row.ppid <= 1) return out;
    cursor = row.ppid;
  }
  return out;
}
