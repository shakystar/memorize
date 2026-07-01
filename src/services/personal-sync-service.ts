import {
  createHttpSyncTransport,
  resolvePersonalStore,
} from '../adapters/sync-transport-http.js';
import { CURRENT_SCHEMA_VERSION, nowIso } from '../domain/common.js';
import type { ProjectSyncState } from '../domain/entities.js';
import { resolveActiveAccount } from '../domain/identity/account.js';
import { getPersonalStoreId } from '../domain/identity/personal-store.js';
import { readToken } from '../storage/credentials-store.js';
import { readJson, writeJson } from '../storage/fs-utils.js';
import { getSyncFile } from '../storage/path-resolver.js';
import { ensurePersonalStore } from './personal-store-service.js';
import { pullProject, pushProject } from './sync-service.js';

/**
 * W1 — personal cross-device sync (memorize SoT-010 own-devices axis). The
 * personal store syncs to the SAME account's other devices via the account's
 * server-minted `psm_` store, and never crosses accounts (the Hub enforces
 * owner-only on the psm_; the client opts through its own personal-store guard
 * explicitly with `allowPersonal`). Two surfaces meet here: the LOCAL personal
 * store id (`personal_self` / `personal_<account>`, a client id) and the REMOTE
 * `psm_…` routing id (server-minted, opaque) bound as `remoteProjectId`.
 */
export interface PersonalSyncResult {
  storeId: string;
  pushed: number;
  pulled: number;
}

export async function syncPersonalStore(params: {
  remoteUrl: string;
  accountId?: string;
}): Promise<PersonalSyncResult> {
  const accountId = params.accountId ?? resolveActiveAccount();
  const token = await readToken(params.remoteUrl);
  if (!token) {
    throw new Error(
      `No stored credential for ${params.remoteUrl}. Run ` +
        `\`memorize auth login --remote-url ${params.remoteUrl}\` first.`,
    );
  }

  // 1. Resolve (and server-provision on first call) this account's psm_ id.
  const { storeId } = await resolvePersonalStore(params.remoteUrl, token);

  // 2. Materialize the local personal store and bind the psm_ remote.
  await ensurePersonalStore(accountId);
  const localId = getPersonalStoreId(accountId);
  await bindPersonalRemote(localId, storeId);

  // 3. Push local personal memory up, then pull the account's union back down.
  //    Same account, own psm_ — the personal-store leak guard is opted through
  //    explicitly (never applies to a project/workspace remote).
  const transport = createHttpSyncTransport(params.remoteUrl, { token });
  const push = await pushProject(localId, transport, { allowPersonal: true });
  const pull = await pullProject(localId, transport, { allowPersonal: true });

  return { storeId, pushed: push.accepted.length, pulled: pull.inserted };
}

/**
 * Bind (or re-bind) the local personal store to its server-minted `psm_` remote.
 * Writes the sync file directly (no `sync.state.updated` event churn); the token
 * stays only in the host credential store (#192), never duplicated here.
 */
async function bindPersonalRemote(
  localId: string,
  remoteStoreId: string,
): Promise<void> {
  const syncFile = getSyncFile(localId);
  const existing = await readJson<ProjectSyncState>(syncFile);
  const now = nowIso();
  if (!existing) {
    const state: ProjectSyncState = {
      id: `sync_${localId}`,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
      projectId: localId,
      remoteProjectId: remoteStoreId,
      syncEnabled: true,
      syncStatus: 'idle',
    };
    await writeJson(syncFile, state);
    return;
  }
  if (existing.remoteProjectId !== remoteStoreId || !existing.syncEnabled) {
    await writeJson(syncFile, {
      ...existing,
      remoteProjectId: remoteStoreId,
      syncEnabled: true,
      updatedAt: now,
    });
  }
}
