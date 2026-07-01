import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION, nowIso } from '../../src/domain/common.js';
import type { ProjectSyncState } from '../../src/domain/entities.js';
import { DEFAULT_ACCOUNT_ID } from '../../src/domain/identity/account.js';
import { getPersonalStoreId } from '../../src/domain/identity/personal-store.js';
import type {
  SyncPullRequest,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
} from '../../src/domain/sync-protocol.js';
import type { SyncTransport } from '../../src/domain/sync-transport.js';
import { importPersonalMemories } from '../../src/services/personal-store-service.js';
import { pullProject, pushProject } from '../../src/services/sync-service.js';
import { closeAll } from '../../src/storage/db.js';
import { writeJson } from '../../src/storage/fs-utils.js';
import { getSyncFile } from '../../src/storage/path-resolver.js';

let sandbox: string;

// A server-minted personal-store id, using the Hub namespace (uppercase allowed)
// that the client's lowercase ID_PATTERN would reject — proving the remote id is
// treated as an opaque routing string, never validated locally.
const PSM = 'psm_3gseJo7gpo7Q';

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-personal-sync-'));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

function capturingTransport(): {
  transport: SyncTransport;
  pushes: SyncPushRequest[];
  pulls: SyncPullRequest[];
} {
  const pushes: SyncPushRequest[] = [];
  const pulls: SyncPullRequest[] = [];
  const transport: SyncTransport = {
    async push(request: SyncPushRequest): Promise<SyncPushResponse> {
      pushes.push(request);
      const ids = request.events.map((e) => e.id);
      return {
        accepted: ids,
        rejected: [],
        ...(ids.length ? { lastAcceptedEventId: ids[ids.length - 1] } : {}),
      };
    },
    async pull(request: SyncPullRequest): Promise<SyncPullResponse> {
      pulls.push(request);
      return { events: [] };
    },
  };
  return { transport, pushes, pulls };
}

async function seedPersonalWithRemote(localId: string): Promise<void> {
  await importPersonalMemories({
    actor: 'claude',
    source: 'test',
    itemsJson: JSON.stringify([
      { kind: 'decision', text: 'a personal preference', salience: 7 },
    ]),
  });
  const now = nowIso();
  const syncFile = getSyncFile(localId);
  mkdirSync(dirname(syncFile), { recursive: true });
  const state: ProjectSyncState = {
    id: `sync_${localId}`,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    projectId: localId,
    remoteProjectId: PSM,
    syncEnabled: true,
    syncStatus: 'idle',
  };
  await writeJson(syncFile, state);
}

describe('personal cross-device sync (W1)', () => {
  it('pushes personal events to the bound psm_ remote when allowPersonal is set', async () => {
    const localId = getPersonalStoreId(DEFAULT_ACCOUNT_ID);
    await seedPersonalWithRemote(localId);
    const { transport, pushes } = capturingTransport();

    const res = await pushProject(localId, transport, { allowPersonal: true });

    expect(pushes).toHaveLength(1);
    const push = pushes[0];
    if (!push) throw new Error('expected one push');
    // Routed by the server-minted psm_ id, not the local personal_self id.
    expect(push.remoteProjectId).toBe(PSM);
    expect(push.events.length).toBeGreaterThan(0);
    expect(res.accepted.length).toBe(push.events.length);
  });

  it('pulls from the psm_ remote when allowPersonal is set', async () => {
    const localId = getPersonalStoreId(DEFAULT_ACCOUNT_ID);
    await seedPersonalWithRemote(localId);
    const { transport, pulls } = capturingTransport();

    const res = await pullProject(localId, transport, { allowPersonal: true });

    expect(pulls).toHaveLength(1);
    const pull = pulls[0];
    if (!pull) throw new Error('expected one pull');
    expect(pull.remoteProjectId).toBe(PSM);
    expect(res).toEqual({ total: 0, inserted: 0 });
  });

  it('still refuses personal push/pull WITHOUT the explicit opt-in (guard intact)', async () => {
    const localId = getPersonalStoreId(DEFAULT_ACCOUNT_ID);
    await seedPersonalWithRemote(localId);
    const { transport } = capturingTransport();

    await expect(pushProject(localId, transport)).rejects.toThrow(
      /personal store/i,
    );
    await expect(pullProject(localId, transport)).rejects.toThrow(
      /personal store/i,
    );
  });
});
