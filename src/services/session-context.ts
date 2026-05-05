import { walkAncestorPids } from '../shared/process-tree.js';
import {
  type CwdSessionPointer,
  SESSION_ENV_VAR,
  currentTtyId,
  listCwdPointers,
  migrateLegacyPointer,
  readCwdPointer,
} from '../storage/cwd-session-store.js';

/**
 * Why a single resolver instead of a per-call fallback chain:
 *
 * Before rc.8 every consumer of "which memorize session am I running
 * inside?" rolled its own priority chain — env, tty, agent-id,
 * most-recent — with subtle differences. The CLI handoff command
 * defaulted to ACTOR_USER when nothing matched; the hook handler
 * called a slightly different `findCwdSession`; the SessionEnd path
 * preferred agentSessionId. Three parallel chains made the rc.6
 * codex-attribution bug invisible until the dogfood — each chain had
 * the same hole but in a different place.
 *
 * `resolveSessionContext` is the only function that walks the chain.
 * Every caller (CLI commands, hook handlers, telemetry middleware)
 * delegates here. The chain itself lives in one place where it can
 * be reasoned about, and `resolvedVia` makes the path the resolver
 * actually took observable when an attribution looks wrong.
 */
export type SessionResolutionPath =
  | 'env'
  | 'agent-pid'
  | 'tty'
  | 'most-recent'
  | 'none';

export interface ResolvedSessionContext {
  sessionId?: string;
  projectId?: string;
  taskId?: string;
  actor?: string;
  agentSessionId?: string;
  agentPid?: number;
  resolvedVia: SessionResolutionPath;
}

export interface ResolveOptions {
  /** Last-resort fallback: when env, agent-pid, and tty all miss,
   *  return the most-recently-started cwd pointer instead of nothing.
   *  Off by default — only ambient CLI entry points (`getCurrentSessionId`)
   *  opt in. Telemetry callers (`bumpHeartbeat`, `endSession`) prefer a
   *  silent miss to a wrong attribution. */
  allowMostRecent?: boolean;
}

const NONE: ResolvedSessionContext = { resolvedVia: 'none' };

function pointerToContext(
  pointer: CwdSessionPointer,
  via: SessionResolutionPath,
): ResolvedSessionContext {
  return {
    sessionId: pointer.sessionId,
    ...(pointer.projectId ? { projectId: pointer.projectId } : {}),
    ...(pointer.taskId ? { taskId: pointer.taskId } : {}),
    ...(pointer.startedBy ? { actor: pointer.startedBy } : {}),
    ...(pointer.agentSessionId ? { agentSessionId: pointer.agentSessionId } : {}),
    ...(pointer.agentPid ? { agentPid: pointer.agentPid } : {}),
    resolvedVia: via,
  };
}

function newestPointer(pointers: CwdSessionPointer[]): CwdSessionPointer {
  return pointers
    .slice()
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0]!;
}

/**
 * Resolves the calling memorize CLI subprocess back to its session
 * pointer. See the module doc for the priority rationale.
 *
 * Priority chain:
 *   1. `MEMORIZE_SESSION_ID` env var — set by Claude via
 *      `CLAUDE_ENV_FILE` and inherited by every child `memorize`
 *      process. This is the cheap, exact path; it short-circuits
 *      everything below when present.
 *   2. Process-tree agent-pid match — walk up from `process.ppid`
 *      collecting ancestor pids, then check whether any of them
 *      matches the `agentPid` we stamped on a cwd pointer at
 *      `SessionStart`. Closes the rc.7 hole where codex CLI
 *      subprocesses had no env to inherit (codex has no equivalent
 *      of `CLAUDE_ENV_FILE`) and tty matching also failed; the
 *      ancestor walk reliably reaches the codex parent process.
 *   3. tty match — current process's stdin tty rdev against the tty
 *      stored at `SessionStart`. Useful when env was lost but the
 *      subprocess inherits the agent's terminal.
 *   4. (opt-in) Most-recently-started pointer in this cwd — only
 *      ambient CLI entry points opt in, since the wrong-attribution
 *      risk is unbounded for telemetry callers.
 */
export async function resolveSessionContext(
  cwd: string,
  options: ResolveOptions = {},
): Promise<ResolvedSessionContext> {
  await migrateLegacyPointer(cwd);

  const fromEnv = process.env[SESSION_ENV_VAR];
  if (fromEnv) {
    const direct = await readCwdPointer(cwd, fromEnv);
    if (direct) return pointerToContext(direct, 'env');
  }

  const all = await listCwdPointers(cwd);
  if (all.length === 0) return NONE;

  // Build a pid → pointer map once so we can ask "is any walked
  // ancestor pid known?" in O(1) per hop.
  const byAgentPid = new Map<number, CwdSessionPointer>();
  for (const p of all) {
    if (typeof p.agentPid === 'number') byAgentPid.set(p.agentPid, p);
  }
  if (byAgentPid.size > 0 && process.ppid) {
    const chain = walkAncestorPids(process.ppid);
    for (const pid of chain) {
      const match = byAgentPid.get(pid);
      if (match) return pointerToContext(match, 'agent-pid');
    }
  }

  const tty = currentTtyId();
  if (tty) {
    const ttyMatches = all.filter((p) => p.tty === tty);
    if (ttyMatches.length > 0) {
      return pointerToContext(newestPointer(ttyMatches), 'tty');
    }
  }

  if (options.allowMostRecent) {
    return pointerToContext(newestPointer(all), 'most-recent');
  }

  return NONE;
}

/**
 * Same chain as `resolveSessionContext` but keyed by the host agent's
 * own session id (Claude UUID, codex session UUID). Used by the
 * SessionEnd hook handler when env propagation is broken but the
 * payload carries the agent's session id we stamped at SessionStart.
 */
export async function resolveByAgentSessionId(
  cwd: string,
  agentId: string,
): Promise<ResolvedSessionContext> {
  const pointers = await listCwdPointers(cwd);
  const match = pointers.find((p) => p.agentSessionId === agentId);
  return match ? pointerToContext(match, 'agent-pid') : NONE;
}
