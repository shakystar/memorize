import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ProjectSyncState } from '../../src/domain/entities.js';
import { setToken } from '../../src/storage/credentials-store.js';
import { readJson } from '../../src/storage/fs-utils.js';
import { getSyncFile } from '../../src/storage/path-resolver.js';
import {
  bindWorkspace,
  getWorkspaceBinding,
  inviteToWorkspace,
  joinAndBindWorkspace,
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

  it('persists the http syncTransport at bind so the workspace is flag-less-syncable (W-b)', async () => {
    await setToken(remoteUrl, 'tok');
    await bindWorkspace(projectId, {
      remoteUrl,
      fetchImpl: fetchMintingWorkspace('wsp_T'),
    });
    const state = await readJson<ProjectSyncState>(getSyncFile(projectId));
    expect(state?.syncTransport).toEqual({ type: 'http', url: remoteUrl });
    expect(state?.syncEnabled).toBe(true);
  });
});

function fetchMintingInvite(): typeof fetch {
  return (async () => ({
    ok: true,
    status: 201,
    statusText: '',
    json: async () => ({
      inviteId: 'inv_1',
      token: 'join-secret',
      joinUrl: `${remoteUrl}/join?token=join-secret`,
      role: 'member',
      maxUses: null,
      expiresAt: null,
    }),
    text: async () => '',
  })) as unknown as typeof fetch;
}

function fetchJoining(workspaceId: string): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    statusText: '',
    json: async () => ({
      workspaceId,
      eventsUrl: `/v1/projects/${workspaceId}/events`,
      role: 'member',
    }),
    text: async () => '',
  })) as unknown as typeof fetch;
}

describe('inviteToWorkspace (W-d)', () => {
  it('mints via the persisted transport URL and mirrors inviteReachable locally', async () => {
    await setToken(remoteUrl, 'tok');
    await bindWorkspace(projectId, {
      remoteUrl,
      fetchImpl: fetchMintingWorkspace('wsp_Inv'),
    });

    // No remoteUrl param — must fall back to the bind-persisted http transport.
    const invite = await inviteToWorkspace(projectId, {
      fetchImpl: fetchMintingInvite(),
    });
    expect(invite.token).toBe('join-secret');

    const binding = await getWorkspaceBinding(projectId);
    expect(binding?.inviteReachable).toBe(true); // private -> shared mirrored
  });

  it('throws for a project that is not workspace-bound', async () => {
    await expect(
      inviteToWorkspace('proj_unbound', { fetchImpl: fetchMintingInvite() }),
    ).rejects.toThrow(/not workspace-bound/);
  });
});

describe('joinAndBindWorkspace (W-d)', () => {
  it('redeems the invite and binds as member with transport + reachable cache', async () => {
    await setToken(remoteUrl, 'tok');
    const binding = await joinAndBindWorkspace('proj_joiner', {
      remoteUrl,
      inviteToken: 'join-secret',
      fetchImpl: fetchJoining('wsp_Joined'),
    });
    expect(binding).toEqual({
      workspaceId: 'wsp_Joined',
      role: 'member',
      inviteReachable: true,
    });
    const state = await readJson<ProjectSyncState>(getSyncFile('proj_joiner'));
    expect(state?.remoteProjectId).toBe('wsp_Joined');
    expect(state?.workspaceRole).toBe('member');
    expect(state?.syncTransport).toEqual({ type: 'http', url: remoteUrl });
  });

  it('refuses a project that is already workspace-bound', async () => {
    await setToken(remoteUrl, 'tok');
    await bindWorkspace(projectId, {
      remoteUrl,
      fetchImpl: fetchMintingWorkspace('wsp_First'),
    });
    await expect(
      joinAndBindWorkspace(projectId, {
        remoteUrl,
        inviteToken: 'join-secret',
        fetchImpl: fetchJoining('wsp_Other'),
      }),
    ).rejects.toThrow(/already bound/);
  });
});
