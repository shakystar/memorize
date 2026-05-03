import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SESSION_ENV_VAR,
  bumpHeartbeat,
  startSession,
} from '../../src/services/session-service.js';

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-session-svc-'));
  delete process.env[SESSION_ENV_VAR];
});

afterEach(async () => {
  delete process.env[SESSION_ENV_VAR];
  await rm(sandbox, { recursive: true, force: true });
});

describe('bumpHeartbeat — telemetry must never break a command', () => {
  it('no-ops silently when no current-session.json exists in cwd', async () => {
    // Fresh cwd with no .memorize directory at all. The middleware in
    // src/cli/index.ts fires bumpHeartbeat after every non-session-managing
    // command, including ones run from arbitrary directories that have
    // never been bound to a memorize project.
    await expect(bumpHeartbeat(sandbox)).resolves.toBeUndefined();
  });

  it('no-ops silently when current session has no projectId (ambient session)', async () => {
    // startSession without a projectId mints an ambient sessionId and
    // writes current-session.json with no projectId. bumpHeartbeat must
    // skip emitting a session.heartbeat event in that case — there is no
    // project to attribute the event to.
    const sessionId = await startSession(sandbox);
    expect(sessionId).toMatch(/^session_/);
    await expect(bumpHeartbeat(sandbox)).resolves.toBeUndefined();
  });
});
