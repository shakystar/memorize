import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION, nowIso } from '../../src/domain/common.js';
import type { ProjectSyncState } from '../../src/domain/entities.js';
import { setToken } from '../../src/storage/credentials-store.js';
import { readJson, writeJson } from '../../src/storage/fs-utils.js';
import { getSyncFile } from '../../src/storage/path-resolver.js';
import {
  ensureSourceStoreRegistration,
  tryEnsureSourceStoreRegistration,
} from '../../src/services/workspace-service.js';

const projectId = 'proj_src_store_test';
const remoteUrl = 'https://hub.test';
const workspaceId = 'wsp_SrcStoreAbc';

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-srcstore-'));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

async function writeBoundState(extra: Partial<ProjectSyncState> = {}): Promise<void> {
  const now = nowIso();
  await writeJson(getSyncFile(projectId), {
    id: `sync_${projectId}`,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    projectId,
    syncStatus: 'idle',
    syncEnabled: true,
    remoteProjectId: workspaceId,
    workspaceRole: 'member',
    inviteReachable: true,
    syncTransport: { type: 'http', url: remoteUrl },
    ...extra,
  } satisfies ProjectSyncState & Partial<ProjectSyncState>);
}

function fetchCapturing(calls: Array<{ url: string; body: unknown }>): typeof fetch {
  return (async (url: unknown, init?: { body?: string }) => {
    calls.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') as unknown });
    return {
      ok: true,
      status: 200,
      statusText: '',
      json: async () => ({ sourceProjectId: projectId, accountId: 'acc_x', label: null }),
      text: async () => '',
    };
  }) as unknown as typeof fetch;
}

const failIfCalled: typeof fetch = (async () => {
  throw new Error('fetch must NOT be called (registration should be cached)');
}) as unknown as typeof fetch;

const rejecting409: typeof fetch = (async () => ({
  ok: false,
  status: 409,
  statusText: 'Conflict',
  json: async () => ({ error: 'source store already registered to another account' }),
  text: async () => 'source store already registered to another account',
})) as unknown as typeof fetch;

describe('ensureSourceStoreRegistration (Hub member attribution)', () => {
  it('is a no-op for a project that is not workspace-bound', async () => {
    expect(await ensureSourceStoreRegistration(projectId)).toBe('not-bound');
  });

  it('registers the local proj_ id with the bound workspace and caches it', async () => {
    await setToken(remoteUrl, 'tok');
    await writeBoundState();

    const calls: Array<{ url: string; body: unknown }> = [];
    const first = await ensureSourceStoreRegistration(projectId, {
      fetchImpl: fetchCapturing(calls),
    });
    expect(first).toBe('registered');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${remoteUrl}/v1/workspaces/${workspaceId}/source-stores`);
    expect(calls[0]?.body).toMatchObject({ sourceProjectId: projectId });

    const state = await readJson<ProjectSyncState>(getSyncFile(projectId));
    expect(state?.sourceStoreRegisteredWith).toBe(workspaceId);

    // Cached: the boundary pays the round-trip once per binding.
    const second = await ensureSourceStoreRegistration(projectId, {
      fetchImpl: failIfCalled,
    });
    expect(second).toBe('cached');
  });

  it('re-registers when the binding moved to a different workspace', async () => {
    await setToken(remoteUrl, 'tok');
    await writeBoundState({ sourceStoreRegisteredWith: 'wsp_OldBinding' });

    const calls: Array<{ url: string; body: unknown }> = [];
    const result = await ensureSourceStoreRegistration(projectId, {
      fetchImpl: fetchCapturing(calls),
    });
    expect(result).toBe('registered');
    expect(calls).toHaveLength(1);
    const state = await readJson<ProjectSyncState>(getSyncFile(projectId));
    expect(state?.sourceStoreRegisteredWith).toBe(workspaceId);
  });

  it('a claim conflict (409) stays uncached so every boundary re-surfaces it', async () => {
    await setToken(remoteUrl, 'tok');
    await writeBoundState();

    const result = await tryEnsureSourceStoreRegistration(projectId, {
      fetchImpl: rejecting409,
    });
    expect(result).toBeUndefined();
    const state = await readJson<ProjectSyncState>(getSyncFile(projectId));
    expect(state?.sourceStoreRegisteredWith).toBeUndefined();
  });
});
