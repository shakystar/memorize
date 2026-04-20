import fs from 'node:fs/promises';
import path from 'node:path';

import { isEnoent, readJson, writeJson } from '../storage/fs-utils.js';

export const SESSION_ENV_VAR = 'MEMORIZE_SESSION_ID';

interface CurrentSessionFile {
  sessionId: string;
  startedAt: string;
  startedBy?: string;
}

function currentSessionFile(cwd: string): string {
  return path.join(cwd, '.memorize', 'current-session.json');
}

function createSessionId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `session_${Date.now().toString(36)}_${random}`;
}

export async function startSession(
  cwd: string,
  startedBy?: string,
): Promise<string> {
  const sessionId = createSessionId();
  const payload: CurrentSessionFile = {
    sessionId,
    startedAt: new Date().toISOString(),
    ...(startedBy ? { startedBy } : {}),
  };
  await writeJson(currentSessionFile(cwd), payload);
  process.env[SESSION_ENV_VAR] = sessionId;
  return sessionId;
}

export async function endSession(cwd: string): Promise<void> {
  try {
    await fs.unlink(currentSessionFile(cwd));
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
  }
  delete process.env[SESSION_ENV_VAR];
}

export async function getCurrentSessionId(cwd: string): Promise<string> {
  const fromEnv = process.env[SESSION_ENV_VAR];
  if (fromEnv) return fromEnv;

  const fromDisk = await readJson<CurrentSessionFile>(currentSessionFile(cwd));
  if (fromDisk?.sessionId) {
    return fromDisk.sessionId;
  }

  return startSession(cwd, 'ambient');
}
