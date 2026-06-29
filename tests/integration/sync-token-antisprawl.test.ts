import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runProjectCommand } from '../../src/cli/commands/project.js';
import { resolveTransport } from '../../src/services/auto-sync-service.js';
import {
  getBoundProjectId,
  readSyncState,
} from '../../src/services/project-service.js';
import { readToken } from '../../src/storage/credentials-store.js';
import { closeAll } from '../../src/storage/db.js';
import { startRelayStub, type RelayStub } from '../harness/relay-stub.js';

let sandbox: string;
let cwd: string;
let relay: RelayStub;

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), 'memorize-antisprawl-')));
  process.env.MEMORIZE_ROOT = join(sandbox, 'root');
  cwd = join(sandbox, 'proj');
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await relay?.close();
  await rm(sandbox, { recursive: true, force: true });
});

describe('token anti-sprawl — clone --token write-through (#192)', () => {
  it('writes an explicit --token to the host store, not into per-project state', async () => {
    relay = await startRelayStub({ token: 'mzk_pat' });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await runProjectCommand(
        ['clone', 'proj_remote', '--remote-url', relay.baseUrl, '--token', 'mzk_pat'],
        { cwd },
      );
    } finally {
      spy.mockRestore();
    }

    // 1. The token landed in the host credential store (git-credential model).
    expect(await readToken(relay.baseUrl)).toBe('mzk_pat');

    // 2. The per-project sync state carries only the URL — no token sprawl.
    const projectId = await getBoundProjectId(cwd);
    expect(projectId).toBeTruthy();
    const state = await readSyncState(projectId!);
    expect(state?.syncTransport).toEqual({ type: 'http', url: relay.baseUrl });
    expect(state?.syncTransport).not.toHaveProperty('token');

    // 3. Despite no per-project token, auto-sync re-resolves it host-side, so a
    //    rebuilt transport still authenticates against the token-gated relay.
    const transport = await resolveTransport(state!);
    expect(transport).toBeDefined();
    const pull = await transport!.pull({
      projectId: projectId!,
      remoteProjectId: 'proj_remote',
    });
    // A 401 would have thrown; reaching an (empty) response proves the token
    // resolved from the host store.
    expect(pull.events).toEqual([]);
  });
});
