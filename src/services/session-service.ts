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

export interface StartSessionOptions {
  actor?: string;
  projectId?: string;
  taskId?: string;
}

export async function startSession(
  cwd: string,
  options: StartSessionOptions = {},
): Promise<string> {
  await migrateLegacyPointer(cwd);

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
  };
  await writeJson(cwdSessionFile(cwd, sessionId), pointer);
  process.env[SESSION_ENV_VAR] = sessionId;
  return sessionId;
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

export async function readActiveSessions(projectId: string): Promise<Session[]> {
  const sessions = await readJsonDir<Session>(getSessionsDir(projectId));
  return sessions.filter((s) => s.status === 'active');
}
