import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../src/domain/common.js';
import type { ProjectSyncState } from '../../src/domain/entities.js';
import { writeJson } from '../../src/storage/fs-utils.js';
import { getSyncFile } from '../../src/storage/path-resolver.js';
import { checkSyncBinding } from '../../src/services/repair-service.js';

const projectId = 'proj_doctor_sync_binding';
const remoteUrl = 'https://hub.test';

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-doctor-syncbind-'));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

async function seedSyncState(patch: Partial<ProjectSyncState>): Promise<void> {
  await writeJson(getSyncFile(projectId), {
    id: `sync_${projectId}`,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    projectId,
    syncEnabled: true,
    syncStatus: 'idle',
    ...patch,
  } satisfies ProjectSyncState);
}

describe('doctor checkSyncBinding (SoT-031)', () => {
  it('is silent for an unsynced project (no sync state at all)', async () => {
    expect(await checkSyncBinding(projectId)).toBeUndefined();
  });

  it('is silent for a single-machine project (state without a transport)', async () => {
    await seedSyncState({});
    expect(await checkSyncBinding(projectId)).toBeUndefined();
  });

  it('is silent for a psm_ personal-store binding', async () => {
    await seedSyncState({
      remoteProjectId: 'psm_Personal',
      syncTransport: { type: 'http', url: remoteUrl },
    });
    expect(await checkSyncBinding(projectId)).toBeUndefined();
  });

  it('reports ok for a canonical workspace binding', async () => {
    await seedSyncState({
      remoteProjectId: 'wsp_Fine',
      workspaceRole: 'owner',
      syncTransport: { type: 'http', url: remoteUrl },
    });
    const check = await checkSyncBinding(projectId);
    expect(check?.status).toBe('ok');
    expect(check?.message).toContain('wsp_Fine');
  });

  it('warns on the deprecated file transport', async () => {
    await seedSyncState({
      remoteProjectId: projectId,
      syncTransport: { type: 'file', location: '/mnt/share' },
    });
    const check = await checkSyncBinding(projectId);
    expect(check?.status).toBe('warn');
    expect(check?.message).toMatch(/deprecated/i);
  });

  it('warns on a wsp_ binding missing its role cache', async () => {
    await seedSyncState({
      remoteProjectId: 'wsp_NoRole',
      syncTransport: { type: 'http', url: remoteUrl },
    });
    const check = await checkSyncBinding(projectId);
    expect(check?.status).toBe('warn');
    expect(check?.message).toContain('role cache');
  });

  it('warns on a legacy proj_-bound http sync with the migration hint', async () => {
    await seedSyncState({
      remoteProjectId: projectId,
      syncTransport: { type: 'http', url: remoteUrl },
    });
    const check = await checkSyncBinding(projectId);
    expect(check?.status).toBe('warn');
    expect(check?.message).toMatch(/403/);
    expect(check?.fix).toContain('sync');
  });

  it('warns on an unbound http sync (self-bind would mint the legacy shape)', async () => {
    await seedSyncState({ syncTransport: { type: 'http', url: remoteUrl } });
    const check = await checkSyncBinding(projectId);
    expect(check?.status).toBe('warn');
    expect(check?.message).toContain('unbound');
  });
});
