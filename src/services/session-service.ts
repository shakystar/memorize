import fs from 'node:fs/promises';
import { fstatSync } from 'node:fs';
import path from 'node:path';

import {
  ACTOR_SYSTEM,
  CURRENT_SCHEMA_VERSION,
  createId,
  nowIso,
} from '../domain/common.js';
import type {
  Session,
  SessionHeartbeatPayload,
} from '../domain/entities.js';
import { createSession } from '../domain/entities.js';
import { appendEvent } from '../storage/event-store.js';
import {
  isEnoent,
  readJson,
  readJsonDir,
  writeJson,
} from '../storage/fs-utils.js';
import { getSessionsDir } from '../storage/path-resolver.js';
import { rebuildProjectProjection } from './projection-store.js';

export const SESSION_ENV_VAR = 'MEMORIZE_SESSION_ID';

/**
 * Pointers older than this without a heartbeat bump are treated as
 * abandoned — no live agent could reasonably go this long without
 * issuing a memorize CLI call (heartbeat fires from CLI middleware).
 * Tunable via MEMORIZE_STALE_SESSION_MS env var for tests / unusual
 * workflows.
 */
const DEFAULT_STALE_SESSION_MS = 30 * 60 * 1000;
function staleThresholdMs(): number {
  const raw = process.env.MEMORIZE_STALE_SESSION_MS;
  if (raw === undefined || raw === '') return DEFAULT_STALE_SESSION_MS;
  const parsed = Number(raw);
  // Accept 0 (reap immediately) for tests and aggressive cleanup.
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_STALE_SESSION_MS;
}

interface CwdSessionPointer {
  sessionId: string;
  startedAt: string;
  startedBy?: string;
  projectId?: string;
  taskId?: string;
  /** Numeric tty rdev (stringified) when the starting process was attached
   *  to a terminal. Used to attribute heartbeats from CLI subprocesses
   *  back to the right session in cwds that host more than one parallel
   *  session — see findCwdSession for the full lookup chain. */
  tty?: string;
  /** The host agent's own session id (Claude UUID, codex turn id, etc.)
   *  captured from the SessionStart hook payload. We persist it here so
   *  later hook events can map back to the right memorize session even
   *  when env propagation fails — Claude's SessionEnd subprocess for
   *  example does NOT inherit MEMORIZE_SESSION_ID, but its payload
   *  carries the same Claude UUID we saw at SessionStart. */
  agentSessionId?: string;
  /** PID of the host agent process (claude / codex), discovered by
   *  walking up the SessionStart hook subprocess's process tree. Used
   *  by the picker to detect dead-but-not-yet-reaped sessions without
   *  changing their status — the pointer file stays on disk so an
   *  explicit `memorize session reap` is still required. Omitted when
   *  process-tree lookup failed (non-Unix runtime, ps unavailable). */
  agentPid?: number;
}

function cwdSessionsDir(cwd: string): string {
  return path.join(cwd, '.memorize', 'sessions');
}

function cwdSessionFile(cwd: string, sessionId: string): string {
  return path.join(cwdSessionsDir(cwd), `${sessionId}.json`);
}

/** Legacy single-pointer location from rc.0 / rc.1. Migrated on first
 *  startSession call, then deleted. */
function legacyCwdSessionFile(cwd: string): string {
  return path.join(cwd, '.memorize', 'current-session.json');
}

function currentTtyId(): string | undefined {
  if (!process.stdin.isTTY) return undefined;
  try {
    return String(fstatSync(0).rdev);
  } catch {
    return undefined;
  }
}

async function readCwdPointer(
  cwd: string,
  sessionId: string,
): Promise<CwdSessionPointer | undefined> {
  return readJson<CwdSessionPointer>(cwdSessionFile(cwd, sessionId));
}

async function listCwdPointers(cwd: string): Promise<CwdSessionPointer[]> {
  return readJsonDir<CwdSessionPointer>(cwdSessionsDir(cwd));
}

async function migrateLegacyPointer(cwd: string): Promise<void> {
  const legacyPath = legacyCwdSessionFile(cwd);
  const legacy = await readJson<CwdSessionPointer>(legacyPath);
  if (!legacy?.sessionId) return;
  const target = cwdSessionFile(cwd, legacy.sessionId);
  // Only migrate if there is no per-session file already at the target.
  // Otherwise we would clobber a fresh pointer with stale data.
  const existing = await readJson<CwdSessionPointer>(target);
  if (!existing) {
    await writeJson(target, legacy);
  }
  try {
    await fs.unlink(legacyPath);
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}

/**
 * Locate the cwd-side pointer for the calling session. Priority:
 *   1. MEMORIZE_SESSION_ID env var (set by Claude via CLAUDE_ENV_FILE
 *      and inherited by every child `memorize` process).
 *   2. tty match — the current process's stdin tty rdev against the
 *      tty stored when each session started.
 *   3. (opt-in) Most-recently-started active pointer in this cwd.
 *
 * The most-recent fallback is OFF by default after the rc.2 dogfood
 * surfaced cross-attribution bugs (Claude's Stop hook killing the most
 * recent codex session because env injection didn't propagate to the
 * subprocess). Only `getCurrentSessionId` opts in, since it is the
 * ambient-CLI entry point that must always return some sessionId.
 * Telemetry callers (`bumpHeartbeat`, `endSession`) prefer a silent
 * miss to a wrong attribution.
 */
async function findCwdSession(
  cwd: string,
  options: { allowMostRecentFallback?: boolean } = {},
): Promise<CwdSessionPointer | undefined> {
  await migrateLegacyPointer(cwd);

  const fromEnv = process.env[SESSION_ENV_VAR];
  if (fromEnv) {
    const direct = await readCwdPointer(cwd, fromEnv);
    if (direct) return direct;
  }

  const all = await listCwdPointers(cwd);
  if (all.length === 0) return undefined;

  const tty = currentTtyId();
  if (tty) {
    const ttyMatch = all
      .filter((p) => p.tty === tty)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];
    if (ttyMatch) return ttyMatch;
  }

  if (!options.allowMostRecentFallback) return undefined;
  return all.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];
}

export interface ReapResult {
  /** Session ids reaped on this call (status was active, now abandoned). */
  reapedSessionIds: string[];
}

/**
 * Sweeps cwd pointers that have gone past the heartbeat staleness
 * threshold (or all of them if `force` is set). For each stale pointer
 * with a projectId, emits a `session.abandoned` event and unlinks the
 * pointer file. Pointers without a projectId (ambient sessions) are
 * just unlinked.
 *
 * Replaces what rc.0..rc.4 mistakenly tried to do via the per-turn
 * `Stop` hook. The hook-driven path was never able to distinguish
 * "agent finished a turn" from "session ended" (and Codex has no
 * session-end hook at all), so reap is now the only mutator of
 * session status — and the only entry point is the explicit
 * `memorize session reap` command. startSession deliberately does
 * NOT auto-sweep on entry, so resume-heavy users (long-lived role
 * sessions reattached via `claude --resume`) keep their pointers
 * across unrelated session starts in the same cwd. The picker
 * filter (readActiveSessions) hides stale pointers from its view
 * without touching their on-disk status.
 */
export async function reapStaleSessions(
  cwd: string,
  options: { force?: boolean } = {},
): Promise<ReapResult> {
  await migrateLegacyPointer(cwd);
  const pointers = await listCwdPointers(cwd);
  if (pointers.length === 0) return { reapedSessionIds: [] };

  const now = Date.now();
  const threshold = staleThresholdMs();
  const reaped: string[] = [];

  for (const pointer of pointers) {
    if (!options.force) {
      const startedAtMs = Date.parse(pointer.startedAt);
      // Use projection's lastSeenAt when available — it tracks heartbeats
      // bumped by every memorize CLI call, which is a much fresher signal
      // than the pointer's startedAt.
      let lastActivityMs = startedAtMs;
      if (pointer.projectId) {
        try {
          const sessionFromProjection = await readJson<Session>(
            path.join(getSessionsDir(pointer.projectId), `${pointer.sessionId}.json`),
          );
          if (sessionFromProjection?.lastSeenAt) {
            lastActivityMs = Date.parse(sessionFromProjection.lastSeenAt);
          }
        } catch {
          // Ignore: fall back to pointer.startedAt.
        }
      }
      if (now - lastActivityMs < threshold) continue;
    }

    if (pointer.projectId) {
      const endedAt = nowIso();
      const abandonedPayload: Session = {
        id: pointer.sessionId,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        createdAt: pointer.startedAt,
        updatedAt: endedAt,
        projectId: pointer.projectId,
        ...(pointer.taskId ? { taskId: pointer.taskId } : {}),
        actor: pointer.startedBy ?? ACTOR_SYSTEM,
        startedAt: pointer.startedAt,
        endedAt,
        lastSeenAt: endedAt,
        status: 'abandoned',
      };
      await appendEvent({
        type: 'session.abandoned',
        projectId: pointer.projectId,
        scopeType: 'session',
        scopeId: pointer.sessionId,
        actor: pointer.startedBy ?? ACTOR_SYSTEM,
        payload: abandonedPayload,
      });
      await rebuildProjectProjection(pointer.projectId);
    }

    try {
      await fs.unlink(cwdSessionFile(cwd, pointer.sessionId));
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    reaped.push(pointer.sessionId);
  }

  return { reapedSessionIds: reaped };
}

export interface StartSessionOptions {
  actor?: string;
  projectId?: string;
  taskId?: string;
  /** The host agent's session id (e.g. Claude's UUID). Persisted on
   *  the cwd pointer so a later hook event whose env was lost (Claude
   *  SessionEnd) can still resolve to the right memorize session. */
  agentSessionId?: string;
  /** PID of the host agent process. See CwdSessionPointer.agentPid. */
  agentPid?: number;
}

export async function startSession(
  cwd: string,
  options: StartSessionOptions = {},
): Promise<string> {
  await migrateLegacyPointer(cwd);
  // No auto-reap here. Step 1 made the picker filter stale pointers
  // out of its view without mutating their status, so the only
  // remaining reason to mark a session abandoned is an explicit
  // `memorize session reap`. This protects users who routinely
  // `claude --resume` a long-lived role session — their pointer must
  // survive until they themselves decide to clean up.

  const actor = options.actor ?? 'ambient';
  let sessionId: string;

  if (options.projectId) {
    const session = createSession({
      projectId: options.projectId,
      actor,
      ...(options.taskId ? { taskId: options.taskId } : {}),
    });
    await appendEvent({
      type: 'session.started',
      projectId: options.projectId,
      scopeType: 'session',
      scopeId: session.id,
      actor,
      payload: session,
    });
    await rebuildProjectProjection(options.projectId);
    sessionId = session.id;
  } else {
    sessionId = createId('session');
  }

  const tty = currentTtyId();
  const pointer: CwdSessionPointer = {
    sessionId,
    startedAt: nowIso(),
    startedBy: actor,
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.taskId ? { taskId: options.taskId } : {}),
    ...(tty ? { tty } : {}),
    ...(options.agentSessionId ? { agentSessionId: options.agentSessionId } : {}),
    ...(options.agentPid ? { agentPid: options.agentPid } : {}),
  };
  await writeJson(cwdSessionFile(cwd, sessionId), pointer);
  process.env[SESSION_ENV_VAR] = sessionId;
  return sessionId;
}

/**
 * Look up the cwd pointer whose stored agentSessionId matches `agentId`.
 * Used by hook handlers (notably SessionEnd) when env propagation
 * cannot be relied on but the hook payload carries the agent's own
 * session id — the SessionStart hook stamped that id on the pointer
 * so we can map it back here.
 */
export async function findCwdSessionByAgentId(
  cwd: string,
  agentId: string,
): Promise<{ sessionId: string; projectId?: string; taskId?: string } | undefined> {
  const pointers = await listCwdPointers(cwd);
  const match = pointers.find((p) => p.agentSessionId === agentId);
  if (!match) return undefined;
  return {
    sessionId: match.sessionId,
    ...(match.projectId ? { projectId: match.projectId } : {}),
    ...(match.taskId ? { taskId: match.taskId } : {}),
  };
}

export interface ResumeSessionOptions {
  /** New agent pid for this resume attempt — captured by the caller
   *  via process-tree walk. Persisted onto the pointer so future
   *  picker liveness checks see the live process, not the dead one. */
  agentPid?: number;
}

/**
 * Re-attaches an existing cwd pointer to a freshly started agent
 * process (Claude --resume on the same UUID, codex resume, …). Bumps
 * the pointer's agentPid + tty + lastSeenAt, emits a `session.resumed`
 * event so the projection sees fresh activity, and seeds the env var
 * so subsequent CLI calls in this subprocess attribute correctly.
 *
 * Returns false (no-op) when the cwd pointer is gone — caller should
 * fall back to startSession in that case.
 */
export async function resumeSession(
  cwd: string,
  sessionId: string,
  options: ResumeSessionOptions = {},
): Promise<boolean> {
  const pointer = await readCwdPointer(cwd, sessionId);
  if (!pointer) return false;

  const tty = currentTtyId();
  const updated: CwdSessionPointer = {
    ...pointer,
    ...(tty ? { tty } : {}),
    ...(options.agentPid ? { agentPid: options.agentPid } : {}),
  };
  await writeJson(cwdSessionFile(cwd, sessionId), updated);
  process.env[SESSION_ENV_VAR] = sessionId;

  if (pointer.projectId) {
    const at = nowIso();
    const heartbeat: SessionHeartbeatPayload = { sessionId, at };
    await appendEvent({
      type: 'session.resumed',
      projectId: pointer.projectId,
      scopeType: 'session',
      scopeId: sessionId,
      actor: pointer.startedBy ?? ACTOR_SYSTEM,
      payload: heartbeat,
    });
    await rebuildProjectProjection(pointer.projectId);
  }
  return true;
}

export interface EndSessionOptions {
  /** Explicit session id from a hook payload (e.g. Claude Stop hook
   *  passes `session_id` in its JSON stdin). When provided we use it
   *  directly and skip env/tty disambiguation, which is the only way
   *  to attribute correctly when neither env propagation nor tty
   *  matching is reliable in the calling subprocess. */
  sessionId?: string;
}

export async function endSession(
  cwd: string,
  options: EndSessionOptions = {},
): Promise<void> {
  const pointer = options.sessionId
    ? await readCwdPointer(cwd, options.sessionId)
    : await findCwdSession(cwd);
  if (!pointer) return;

  if (pointer.projectId) {
    const endedAt = nowIso();
    const completedPayload: Session = {
      id: pointer.sessionId,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: pointer.startedAt,
      updatedAt: endedAt,
      projectId: pointer.projectId,
      ...(pointer.taskId ? { taskId: pointer.taskId } : {}),
      actor: pointer.startedBy ?? ACTOR_SYSTEM,
      startedAt: pointer.startedAt,
      endedAt,
      lastSeenAt: endedAt,
      status: 'completed',
    };
    await appendEvent({
      type: 'session.completed',
      projectId: pointer.projectId,
      scopeType: 'session',
      scopeId: pointer.sessionId,
      actor: pointer.startedBy ?? ACTOR_SYSTEM,
      payload: completedPayload,
    });
    await rebuildProjectProjection(pointer.projectId);
  }

  try {
    await fs.unlink(cwdSessionFile(cwd, pointer.sessionId));
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  if (process.env[SESSION_ENV_VAR] === pointer.sessionId) {
    delete process.env[SESSION_ENV_VAR];
  }
}

/**
 * Best-effort heartbeat — bumps lastSeenAt on the active session record so
 * other agents can see this session is still working. Silently no-ops for
 * ambient sessions (no projectId) and for caller-side errors so commands
 * never fail because of telemetry.
 */
export async function bumpHeartbeat(cwd: string): Promise<void> {
  let pointer: CwdSessionPointer | undefined;
  try {
    pointer = await findCwdSession(cwd);
  } catch {
    return;
  }
  if (!pointer?.projectId) return;

  try {
    const payload: SessionHeartbeatPayload = {
      sessionId: pointer.sessionId,
      at: nowIso(),
    };
    await appendEvent({
      type: 'session.heartbeat',
      projectId: pointer.projectId,
      scopeType: 'session',
      scopeId: pointer.sessionId,
      actor: pointer.startedBy ?? ACTOR_SYSTEM,
      payload,
    });
    await rebuildProjectProjection(pointer.projectId);
  } catch {
    // never let telemetry break a command
  }
}

export async function getCurrentSessionId(cwd: string): Promise<string> {
  const fromEnv = process.env[SESSION_ENV_VAR];
  if (fromEnv) return fromEnv;

  // Ambient CLI entry point — opt into the most-recent fallback so the
  // user can run `memorize task list` from a fresh shell without minting
  // a new session every time.
  const pointer = await findCwdSession(cwd, { allowMostRecentFallback: true });
  if (pointer?.sessionId) return pointer.sessionId;

  return startSession(cwd, { actor: 'ambient' });
}

/**
 * Returns the taskId this session claimed at startSession, if any.
 * Used by hook handlers to attribute checkpoints / handoffs to the
 * right task instead of falling back to project.activeTaskIds[0],
 * which would point at an arbitrary other agent's work.
 */
export async function getCurrentSessionTaskId(
  cwd: string,
): Promise<string | undefined> {
  const pointer = await findCwdSession(cwd);
  return pointer?.taskId;
}

export async function readActiveSessions(projectId: string): Promise<Session[]> {
  const sessions = await readJsonDir<Session>(getSessionsDir(projectId));
  // The picker view: status === 'active' AND we've seen a heartbeat
  // within the staleness threshold. We deliberately do NOT mutate the
  // on-disk session status here — a stale-but-alive session (long
  // human turn between memorize CLI calls) just disappears from the
  // picker until the next heartbeat. Reaping (status → abandoned)
  // remains explicit, owned by `memorize session reap`.
  const threshold = staleThresholdMs();
  if (threshold === 0) {
    // Tests using MEMORIZE_STALE_SESSION_MS=0 want every active
    // session visible regardless of age (otherwise nothing would
    // show up in synthetic in-memory fixtures). Treat 0 as "no
    // staleness filter" for the picker, distinct from its reap
    // semantics ("reap immediately").
    return sessions.filter((s) => s.status === 'active');
  }
  const now = Date.now();
  return sessions.filter((s) => {
    if (s.status !== 'active') return false;
    const lastSeenMs = Date.parse(s.lastSeenAt);
    if (!Number.isFinite(lastSeenMs)) return true;
    return now - lastSeenMs < threshold;
  });
}
