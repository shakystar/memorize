import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setToken } from '../../src/storage/credentials-store.js';
import {
  bindWorkspace,
  getWorkspaceBinding,
} from '../../src/services/workspace-service.js';

const projectId = 'proj_ws_bind_test';
const remoteUrl = 'https://hub.test';

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-wsbind-'));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

function fetchMintingWorkspace(workspaceId: string): typeof fetch {
  return (async () => ({
    ok: true,
    status: 201,
    statusText: '',
    json: async () => ({
      workspaceId,
      eventsUrl: `/v1/projects/${workspaceId}/events`,
      role: 'owner',
      inviteReachable: false,
    }),
    text: async () => '',
  })) as unknown as typeof fetch;
}

const failIfCalled: typeof fetch = (async () => {
  throw new Error('fetch must NOT be called (idempotent bind should not re-mint)');
}) as unknown as typeof fetch;

describe('bindWorkspace / getWorkspaceBinding (W-a)', () => {
  it('mints a wsp_ and binds it to the project sync state', async () => {
    await setToken(remoteUrl, 'tok');

    const result = await bindWorkspace(projectId, {
      remoteUrl,
      name: 'Team',
      fetchImpl: fetchMintingWorkspace('wsp_MintedAbc'),
    });

    expect(result).toEqual({
      workspaceId: 'wsp_MintedAbc',
      role: 'owner',
      inviteReachable: false,
      created: true,
    });

    // Persisted and readable back as a binding.
    const binding = await getWorkspaceBinding(projectId);
    expect(binding).toEqual({
      workspaceId: 'wsp_MintedAbc',
      role: 'owner',
      inviteReachable: false,
    });
  });

  it('is idempotent: a second bind returns the existing wsp_ and never re-mints', async () => {
    await setToken(remoteUrl, 'tok');
    await bindWorkspace(projectId, {
      remoteUrl,
      fetchImpl: fetchMintingWorkspace('wsp_First'),
    });

    // Even with a fetch that would mint a DIFFERENT id (and throws if called),
    // the existing binding is returned untouched.
    const again = await bindWorkspace(projectId, {
      remoteUrl,
      fetchImpl: failIfCalled,
    });
    expect(again).toEqual({
      workspaceId: 'wsp_First',
      role: 'owner',
      inviteReachable: false,
      created: false,
    });
  });

  it('throws a helpful error when no host credential is stored', async () => {
    await expect(
      bindWorkspace(projectId, {
        remoteUrl,
        fetchImpl: fetchMintingWorkspace('wsp_x'),
      }),
    ).rejects.toThrow(/auth login/);
  });

  it('returns undefined for a project that is not workspace-bound', async () => {
    expect(await getWorkspaceBinding('proj_never_bound')).toBeUndefined();
  });
});
