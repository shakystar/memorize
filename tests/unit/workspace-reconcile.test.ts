import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../src/domain/common.js';
import type { ProjectSyncState } from '../../src/domain/entities.js';
import { setToken } from '../../src/storage/credentials-store.js';
import { readJson, writeJson } from '../../src/storage/fs-utils.js';
import { getSyncFile } from '../../src/storage/path-resolver.js';
import {
  reconcileWorkspaceBinding,
  tryReconcileWorkspaceBinding,
} from '../../src/services/workspace-service.js';

const projectId = 'proj_ws_reconcile_test';
const remoteUrl = 'https://hub.test';

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-wsreconcile-'));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

async function seedSyncState(
  patch: Partial<ProjectSyncState>,
): Promise<ProjectSyncState> {
  const state: ProjectSyncState = {
    id: `sync_${projectId}`,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    projectId,
    syncEnabled: true,
    syncStatus: 'idle',
    ...patch,
  };
  await writeJson(getSyncFile(projectId), state);
  return state;
}

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

function fetchListingWorkspaces(
  entries: Array<{ workspaceId: string; role: string; inviteReachable: boolean }>,
): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    statusText: '',
    json: async () => ({
      workspaces: entries.map((entry) => ({
        ...entry,
        eventsUrl: `/v1/projects/${entry.workspaceId}/events`,
        name: null,
        memberCount: 1,
      })),
    }),
    text: async () => '',
  })) as unknown as typeof fetch;
}

const fetch404: typeof fetch = (async () => ({
  ok: false,
  status: 404,
  statusText: 'Not Found',
  json: async () => ({}),
  text: async () => 'not found',
})) as unknown as typeof fetch;

const failIfCalled: typeof fetch = (async () => {
  throw new Error('fetch must NOT be called for this shape');
}) as unknown as typeof fetch;

describe('reconcileWorkspaceBinding (W-b full reconcile, SoT-031)', () => {
  it('migrates a legacy proj_ self-bind: mints a wsp_, rebinds, drops both watermarks', async () => {
    await setToken(remoteUrl, 'tok');
    await seedSyncState({
      remoteProjectId: projectId, // the pre-workspace first-push self-bind
      syncTransport: { type: 'http', url: remoteUrl },
      lastPushedEventId: 'evt_50',
      lastPulledEventId: 'evt_90',
    });

    const outcome = await reconcileWorkspaceBinding(projectId, {
      fetchImpl: fetchMintingWorkspace('wsp_Migrated'),
    });
    expect(outcome).toEqual({ action: 'migrated', workspaceId: 'wsp_Migrated' });

    const state = await readJson<ProjectSyncState>(getSyncFile(projectId));
    expect(state?.remoteProjectId).toBe('wsp_Migrated');
    expect(state?.workspaceRole).toBe('owner');
    expect(state?.inviteReachable).toBe(false);
    expect(state?.syncEnabled).toBe(true);
    // The Hub never held the proj_ log (403 side-effect-free), so the fresh
    // store starts empty: full local history must re-push, pull cursor resets.
    expect(state?.lastPushedEventId).toBeUndefined();
    expect(state?.lastPulledEventId).toBeUndefined();
    // Identity/provenance of the sync state itself survives the rebind.
    expect(state?.id).toBe(`sync_${projectId}`);
    expect(state?.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(state?.syncTransport).toEqual({ type: 'http', url: remoteUrl });
  });

  it('migrates an unbound http sync (no remoteProjectId) the same way', async () => {
    await setToken(remoteUrl, 'tok');
    await seedSyncState({ syncTransport: { type: 'http', url: remoteUrl } });

    const outcome = await reconcileWorkspaceBinding(projectId, {
      fetchImpl: fetchMintingWorkspace('wsp_Fresh'),
    });
    expect(outcome).toEqual({ action: 'migrated', workspaceId: 'wsp_Fresh' });
    const state = await readJson<ProjectSyncState>(getSyncFile(projectId));
    expect(state?.remoteProjectId).toBe('wsp_Fresh');
    expect(state?.workspaceRole).toBe('owner');
  });

  it('backfills the role cache for a wsp_ binding without one (adoption, not a mint)', async () => {
    await setToken(remoteUrl, 'tok');
    await seedSyncState({
      remoteProjectId: 'wsp_Adopted', // e.g. `project sync --bind wsp_…`
      syncTransport: { type: 'http', url: remoteUrl },
      lastPushedEventId: 'evt_7',
      lastPulledEventId: 'evt_9',
    });

    const outcome = await reconcileWorkspaceBinding(projectId, {
      fetchImpl: fetchListingWorkspaces([
        { workspaceId: 'wsp_Adopted', role: 'member', inviteReachable: true },
      ]),
    });
    expect(outcome).toEqual({
      action: 'role-backfilled',
      workspaceId: 'wsp_Adopted',
    });

    const state = await readJson<ProjectSyncState>(getSyncFile(projectId));
    expect(state?.workspaceRole).toBe('member');
    expect(state?.inviteReachable).toBe(true);
    // Same store — the watermarks stay valid and MUST survive.
    expect(state?.lastPushedEventId).toBe('evt_7');
    expect(state?.lastPulledEventId).toBe('evt_9');
  });

  it('throws when the bound wsp_ does not list this account', async () => {
    await setToken(remoteUrl, 'tok');
    await seedSyncState({
      remoteProjectId: 'wsp_NotMine',
      syncTransport: { type: 'http', url: remoteUrl },
    });
    await expect(
      reconcileWorkspaceBinding(projectId, {
        fetchImpl: fetchListingWorkspaces([
          { workspaceId: 'wsp_Other', role: 'owner', inviteReachable: false },
        ]),
      }),
    ).rejects.toThrow(/does not list this account/);
  });

  it('is a no-op for a canonical binding (wsp_ + role cache)', async () => {
    await seedSyncState({
      remoteProjectId: 'wsp_Fine',
      workspaceRole: 'owner',
      syncTransport: { type: 'http', url: remoteUrl },
    });
    expect(
      await reconcileWorkspaceBinding(projectId, { fetchImpl: failIfCalled }),
    ).toEqual({ action: 'none' });
  });

  it('is a no-op for a file transport (out of scope, SoT-031)', async () => {
    await seedSyncState({
      remoteProjectId: projectId,
      syncTransport: { type: 'file', location: '/mnt/share' },
    });
    expect(
      await reconcileWorkspaceBinding(projectId, { fetchImpl: failIfCalled }),
    ).toEqual({ action: 'none' });
  });

  it('is a no-op for a psm_ binding (personal store has its own resolve path)', async () => {
    await seedSyncState({
      remoteProjectId: 'psm_Personal',
      syncTransport: { type: 'http', url: remoteUrl },
    });
    expect(
      await reconcileWorkspaceBinding(projectId, { fetchImpl: failIfCalled }),
    ).toEqual({ action: 'none' });
  });

  it('leaves a bare-relay sync untouched when the control-plane 404s', async () => {
    await setToken(remoteUrl, 'tok');
    const seeded = await seedSyncState({
      remoteProjectId: projectId,
      syncTransport: { type: 'http', url: remoteUrl },
      lastPushedEventId: 'evt_3',
    });

    const outcome = await reconcileWorkspaceBinding(projectId, {
      fetchImpl: fetch404,
    });
    expect(outcome).toEqual({ action: 'none' });

    const state = await readJson<ProjectSyncState>(getSyncFile(projectId));
    expect(state).toEqual(seeded); // byte-identical: nothing was written
  });

  it('throws a helpful error when no host credential is stored', async () => {
    await seedSyncState({
      remoteProjectId: projectId,
      syncTransport: { type: 'http', url: remoteUrl },
    });
    await expect(
      reconcileWorkspaceBinding(projectId, { fetchImpl: failIfCalled }),
    ).rejects.toThrow(/auth login/);
  });
});

describe('tryReconcileWorkspaceBinding (sync-boundary wrapper)', () => {
  it('degrades an error to undefined (warn) instead of failing the boundary', async () => {
    await seedSyncState({
      remoteProjectId: projectId,
      syncTransport: { type: 'http', url: remoteUrl },
    });
    // No credential stored → the inner reconcile throws; the wrapper must not.
    expect(
      await tryReconcileWorkspaceBinding(projectId, { fetchImpl: failIfCalled }),
    ).toBeUndefined();
  });

  it('passes the outcome through on success', async () => {
    await setToken(remoteUrl, 'tok');
    await seedSyncState({
      remoteProjectId: projectId,
      syncTransport: { type: 'http', url: remoteUrl },
    });
    expect(
      await tryReconcileWorkspaceBinding(projectId, {
        fetchImpl: fetchMintingWorkspace('wsp_ViaTry'),
      }),
    ).toEqual({ action: 'migrated', workspaceId: 'wsp_ViaTry' });
  });
});
