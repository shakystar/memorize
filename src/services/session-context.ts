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
  | 'agent-env'
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
  /** When `MEMORIZE_DEBUG` is set, emit one stderr line tagged with
   *  this label showing which resolution path was taken. Used to
   *  diagnose attribution mismatches in dogfood without changing the
   *  resolution logic itself. */
  debugLabel?: string;
}

const NONE: ResolvedSessionContext = { resolvedVia: 'none' };

interface DebugExtras {
  /** Walked ancestor pid chain from `process.ppid` upward — included
   *  so dogfood can tell "agent-pid path didn't even reach the codex
   *  pid" (chain ends at 1 too early) from "agent-pid path saw it but
   *  the pointer didn't have it stamped" (chain includes the pid but
   *  no pointer matched). */
  walked?: number[];
  /** All `agentPid` values stamped on cwd pointers — the set the walk
   *  was looking for. Empty list ⇒ no SessionStart ever stamped one
   *  in this cwd. */
  pointerPids?: number[];
}

function emitDebug(
  label: string | undefined,
  ctx: ResolvedSessionContext,
  extras: DebugExtras = {},
): void {
  if (!label) return;
  if (!process.env.MEMORIZE_DEBUG) return;
  const parts = [
    `label=${label}`,
    `via=${ctx.resolvedVia}`,
    `session=${ctx.sessionId ?? '-'}`,
    `task=${ctx.taskId ?? '-'}`,
    `actor=${ctx.actor ?? '-'}`,
    `agentPid=${ctx.agentPid ?? '-'}`,
    `agentSession=${ctx.agentSessionId ?? '-'}`,
    `ppid=${process.ppid ?? '-'}`,
    `walked=[${(extras.walked ?? []).join(',')}]`,
    `pointerPids=[${(extras.pointerPids ?? []).join(',')}]`,
  ];
  process.stderr.write(`[memorize-debug] resolve ${parts.join(' ')}\n`);
}

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
 *   2. Agent-native env match — codex propagates its own session
 *      UUID as `CODEX_THREAD_ID` to subprocess env. We stamp that
 *      same UUID as `agentSessionId` on the cwd pointer at
 *      `SessionStart`, so we resolve back to the session by env
 *      even though codex has no equivalent of `CLAUDE_ENV_FILE`
 *      for our own `MEMORIZE_SESSION_ID`. Round-5 dogfood proved
 *      the agent-pid walk below is structurally broken on macOS:
 *      Claude/codex shell tool workers get reparented to launchd,
 *      so a CLI subprocess walking up its ancestor chain never
 *      reaches the agent root pid. This env path is the codex
 *      equivalent of the Claude env path above.
 *   3. Process-tree agent-pid match — walk up from `process.ppid`
 *      collecting ancestor pids, then check whether any of them
 *      matches the `agentPid` we stamped on a cwd pointer at
 *      `SessionStart`. Mostly a defensive fallback now; in
 *      practice the env paths above handle every case we have
 *      seen in dogfood.
 *   4. tty match — current process's stdin tty rdev against the tty
 *      stored at `SessionStart`. Useful when env was lost but the
 *      subprocess inherits the agent's terminal.
 *   5. (opt-in) Most-recently-started pointer in this cwd — only
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
    if (direct) {
      const ctx = pointerToContext(direct, 'env');
      emitDebug(options.debugLabel, ctx, debugExtras([direct]));
      return ctx;
    }
  }

  const all = await listCwdPointers(cwd);
  if (all.length === 0) {
    emitDebug(options.debugLabel, NONE, debugExtras([]));
    return NONE;
  }

  // Agent-native session id env. Currently codex only — codex
  // propagates `CODEX_THREAD_ID` (its session UUID) to every
  // subprocess and we stamp that same UUID as `agentSessionId` on
  // the cwd pointer at SessionStart. This closes the round-5 hole
  // where the agent-pid walk below couldn't reach codex on macOS
  // (workers get reparented to launchd). Add new agents here as
  // their env contracts are confirmed.
  const codexThreadId = process.env.CODEX_THREAD_ID;
  if (codexThreadId) {
    const match = all.find((p) => p.agentSessionId === codexThreadId);
    if (match) {
      const ctx = pointerToContext(match, 'agent-env');
      emitDebug(options.debugLabel, ctx, debugExtras(all));
      return ctx;
    }
  }

  // Build a pid → pointer map once so we can ask "is any walked
  // ancestor pid known?" in O(1) per hop.
  const byAgentPid = new Map<number, CwdSessionPointer>();
  for (const p of all) {
    if (typeof p.agentPid === 'number') byAgentPid.set(p.agentPid, p);
  }
  let chain: number[] = [];
  if (byAgentPid.size > 0 && process.ppid) {
    chain = walkAncestorPids(process.ppid);
    for (const pid of chain) {
      const match = byAgentPid.get(pid);
      if (match) {
        const ctx = pointerToContext(match, 'agent-pid');
        emitDebug(options.debugLabel, ctx, debugExtras(all, chain));
        return ctx;
      }
    }
  }

  const tty = currentTtyId();
  if (tty) {
    const ttyMatches = all.filter((p) => p.tty === tty);
    if (ttyMatches.length > 0) {
      const ctx = pointerToContext(newestPointer(ttyMatches), 'tty');
      emitDebug(options.debugLabel, ctx, debugExtras(all, chain));
      return ctx;
    }
  }

  if (options.allowMostRecent) {
    const ctx = pointerToContext(newestPointer(all), 'most-recent');
    emitDebug(options.debugLabel, ctx, debugExtras(all, chain));
    return ctx;
  }

  emitDebug(options.debugLabel, NONE, debugExtras(all, chain));
  return NONE;
}

function debugExtras(
  pointers: CwdSessionPointer[],
  walked?: number[],
): DebugExtras {
  if (!process.env.MEMORIZE_DEBUG) return {};
  // When DEBUG is set but the agent-pid branch was skipped (env hit
  // first, or the byAgentPid map was empty), still walk the chain so
  // dogfood can compare "what we walked" against "what was stamped".
  const computedWalked =
    walked && walked.length > 0
      ? walked
      : process.ppid
        ? walkAncestorPids(process.ppid)
        : [];
  return {
    walked: computedWalked,
    pointerPids: pointers
      .map((p) => p.agentPid)
      .filter((p): p is number => typeof p === 'number'),
  };
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
  options: { debugLabel?: string } = {},
): Promise<ResolvedSessionContext> {
  const pointers = await listCwdPointers(cwd);
  const match = pointers.find((p) => p.agentSessionId === agentId);
  const ctx = match ? pointerToContext(match, 'agent-pid') : NONE;
  emitDebug(options.debugLabel, ctx);
  return ctx;
}
