import fs from 'node:fs/promises';
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
import { isEnoent, readJson, readJsonDir, writeJson } from '../storage/fs-utils.js';
import { getSessionsDir } from '../storage/path-resolver.js';
import { rebuildProjectProjection } from './projection-store.js';

export const SESSION_ENV_VAR = 'MEMORIZE_SESSION_ID';

interface CurrentSessionFile {
  sessionId: string;
  startedAt: string;
  startedBy?: string;
  projectId?: string;
  taskId?: string;
}

function currentSessionFile(cwd: string): string {
  return path.join(cwd, '.memorize', 'current-session.json');
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
  const actor = options.actor ?? 'ambient';
  let sessionId: string;

  if (options.projectId) {
    // With a project context we emit a real session.started event so
    // the projector can build the Session record. Without one we just
    // mint an id (ambient sessions during read-only commands).
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

  const payload: CurrentSessionFile = {
    sessionId,
    startedAt: nowIso(),
    startedBy: actor,
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.taskId ? { taskId: options.taskId } : {}),
  };
  await writeJson(currentSessionFile(cwd), payload);
  process.env[SESSION_ENV_VAR] = sessionId;
  return sessionId;
}

export async function endSession(cwd: string): Promise<void> {
  const current = await readJson<CurrentSessionFile>(currentSessionFile(cwd));

  if (current?.projectId) {
    const endedAt = nowIso();
    // Minimal Session-shaped payload — projector for session.completed
    // reads scopeId; payload contents are advisory.
    const completedPayload: Session = {
      id: current.sessionId,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: current.startedAt,
      updatedAt: endedAt,
      projectId: current.projectId,
      ...(current.taskId ? { taskId: current.taskId } : {}),
      actor: current.startedBy ?? ACTOR_SYSTEM,
      startedAt: current.startedAt,
      endedAt,
      lastSeenAt: endedAt,
      status: 'completed',
    };
    await appendEvent({
      type: 'session.completed',
      projectId: current.projectId,
      scopeType: 'session',
      scopeId: current.sessionId,
      actor: current.startedBy ?? ACTOR_SYSTEM,
      payload: completedPayload,
    });
    await rebuildProjectProjection(current.projectId);
  }

  try {
    await fs.unlink(currentSessionFile(cwd));
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  delete process.env[SESSION_ENV_VAR];
}

/**
 * Best-effort heartbeat — bumps lastSeenAt on the active session record so
 * other agents can see this session is still working. Silently no-ops for
 * ambient sessions (no projectId) and for caller-side errors so commands
 * never fail because of telemetry.
 */
export async function bumpHeartbeat(cwd: string): Promise<void> {
  let current: CurrentSessionFile | undefined;
  try {
    current = await readJson<CurrentSessionFile>(currentSessionFile(cwd));
  } catch {
    return;
  }
  if (!current?.projectId) return;

  try {
    const payload: SessionHeartbeatPayload = {
      sessionId: current.sessionId,
      at: nowIso(),
    };
    await appendEvent({
      type: 'session.heartbeat',
      projectId: current.projectId,
      scopeType: 'session',
      scopeId: current.sessionId,
      actor: current.startedBy ?? ACTOR_SYSTEM,
      payload,
    });
    await rebuildProjectProjection(current.projectId);
  } catch {
    // never let telemetry break a command
  }
}

export async function getCurrentSessionId(cwd: string): Promise<string> {
  const fromEnv = process.env[SESSION_ENV_VAR];
  if (fromEnv) return fromEnv;

  const fromDisk = await readJson<CurrentSessionFile>(currentSessionFile(cwd));
  if (fromDisk?.sessionId) {
    return fromDisk.sessionId;
  }

  return startSession(cwd, { actor: 'ambient' });
}

export async function readActiveSessions(projectId: string): Promise<Session[]> {
  const sessions = await readJsonDir<Session>(getSessionsDir(projectId));
  return sessions.filter((s) => s.status === 'active');
}
