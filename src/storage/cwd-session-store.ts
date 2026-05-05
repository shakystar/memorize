import fs from 'node:fs/promises';
import { fstatSync } from 'node:fs';
import path from 'node:path';

import { isEnoent, readJson, readJsonDir, writeJson } from './fs-utils.js';

/**
 * On-disk shape of a cwd-side session pointer
 * (`<cwd>/.memorize/sessions/<sessionId>.json`). Owned by this
 * storage module — both `session-service` (lifecycle: create / end /
 * resume / reap) and `session-context` (resolution: which session am
 * I?) read and write through here so the file shape stays in one
 * place.
 */
export interface CwdSessionPointer {
  sessionId: string;
  startedAt: string;
  startedBy?: string;
  projectId?: string;
  taskId?: string;
  /** Numeric tty rdev (stringified) when the starting process was
   *  attached to a terminal. Used by tty-fallback resolution when
   *  env propagation is broken. */
  tty?: string;
  /** The host agent's own session id (Claude UUID, codex session
   *  UUID, etc.) captured from the SessionStart hook payload. Lets
   *  later hook events resolve back to the right memorize session
   *  even when env propagation fails — Claude's SessionEnd subprocess
   *  for example does NOT inherit MEMORIZE_SESSION_ID. */
  agentSessionId?: string;
  /** PID of the host agent process (claude / codex), discovered by
   *  walking up the SessionStart hook subprocess's process tree.
   *  Used by `resolveSessionContext` to attribute later memorize CLI
   *  subprocesses back to this session via their ancestor walk —
   *  the only reliable identity path for codex (which does not
   *  expose its session id via env). */
  agentPid?: number;
}

export const SESSION_ENV_VAR = 'MEMORIZE_SESSION_ID';

export function cwdSessionsDir(cwd: string): string {
  return path.join(cwd, '.memorize', 'sessions');
}

export function cwdSessionFile(cwd: string, sessionId: string): string {
  return path.join(cwdSessionsDir(cwd), `${sessionId}.json`);
}

/** Legacy single-pointer location from rc.0 / rc.1. Migrated on first
 *  resolve / startSession call, then deleted. */
function legacyCwdSessionFile(cwd: string): string {
  return path.join(cwd, '.memorize', 'current-session.json');
}

export function currentTtyId(): string | undefined {
  if (!process.stdin.isTTY) return undefined;
  try {
    return String(fstatSync(0).rdev);
  } catch {
    return undefined;
  }
}

export async function readCwdPointer(
  cwd: string,
  sessionId: string,
): Promise<CwdSessionPointer | undefined> {
  return readJson<CwdSessionPointer>(cwdSessionFile(cwd, sessionId));
}

export async function listCwdPointers(cwd: string): Promise<CwdSessionPointer[]> {
  return readJsonDir<CwdSessionPointer>(cwdSessionsDir(cwd));
}

export async function writeCwdPointer(
  cwd: string,
  pointer: CwdSessionPointer,
): Promise<void> {
  await writeJson(cwdSessionFile(cwd, pointer.sessionId), pointer);
}

export async function deleteCwdPointer(
  cwd: string,
  sessionId: string,
): Promise<void> {
  try {
    await fs.unlink(cwdSessionFile(cwd, sessionId));
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}

export async function migrateLegacyPointer(cwd: string): Promise<void> {
  const legacyPath = legacyCwdSessionFile(cwd);
  const legacy = await readJson<CwdSessionPointer>(legacyPath);
  if (!legacy?.sessionId) return;
  const target = cwdSessionFile(cwd, legacy.sessionId);
  // Only migrate if there is no per-session file already at the
  // target. Otherwise we would clobber a fresh pointer with stale
  // data.
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
