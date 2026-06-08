import {
  ACTOR_SYSTEM,
  CURRENT_SCHEMA_VERSION,
  assertValidId,
  nowIso,
} from '../domain/common.js';
import type { ProjectSyncState } from '../domain/entities.js';
import type {
  SyncPullResponse,
  SyncPullResult,
  SyncPushRequest,
  SyncPushResponse,
  SyncQueueSnapshot,
} from '../domain/sync-protocol.js';
import type { SyncTransport } from '../domain/sync-transport.js';
import { bindProject, resolveProjectIdForPath } from '../storage/bindings-store.js';
import {
  appendEvent,
  ensureProjectDirectories,
  insertExternalEvents,
  readEventsSince,
} from '../storage/event-store.js';
import { readJson, writeJson } from '../storage/fs-utils.js';
import { getSyncFile } from '../storage/path-resolver.js';
import { rebuildProjectProjection } from './projection-store.js';

async function readStateOrThrow(projectId: string): Promise<ProjectSyncState> {
  const state = await readJson<ProjectSyncState>(getSyncFile(projectId));
  if (!state) {
    throw new Error(`Sync state is missing for project ${projectId}.`);
  }
  return state;
}

async function writeState(state: ProjectSyncState): Promise<void> {
  await writeJson(getSyncFile(state.projectId), state);
  await appendEvent({
    type: 'sync.state.updated',
    projectId: state.projectId,
    scopeType: 'project',
    scopeId: state.projectId,
    actor: ACTOR_SYSTEM,
    payload: state,
  });
}

export async function updateSyncState(
  projectId: string,
  patch: Partial<Omit<ProjectSyncState, 'id' | 'projectId' | 'createdAt' | 'schemaVersion'>>,
): Promise<ProjectSyncState> {
  const current = await readStateOrThrow(projectId);
  const next: ProjectSyncState = {
    ...current,
    ...patch,
    updatedAt: nowIso(),
  };
  await writeState(next);
  return next;
}

export async function buildPushPayload(
  projectId: string,
): Promise<SyncPushRequest> {
  const state = await readStateOrThrow(projectId);
  // Seq-watermark slice: events with seq greater than the lastPushed row,
  // in seq order. Still excludes local sync bookkeeping events.
  const pending = (
    await readEventsSince(projectId, state.lastPushedEventId)
  ).filter((event) => event.type !== 'sync.state.updated');
  return {
    projectId,
    ...(state.remoteProjectId ? { remoteProjectId: state.remoteProjectId } : {}),
    ...(state.lastPushedEventId
      ? { sincePushedEventId: state.lastPushedEventId }
      : {}),
    events: pending,
  };
}

export async function markPushed(
  projectId: string,
  lastAcceptedEventId: string,
): Promise<ProjectSyncState> {
  return updateSyncState(projectId, {
    lastPushedEventId: lastAcceptedEventId,
    lastSyncAt: nowIso(),
  });
}

/**
 * Apply-on-pull. Insert pulled events into the SQLite log (INSERT OR IGNORE,
 * idempotent), rebuild the projection, THEN advance the watermark last. A crash
 * before the watermark advances leaves it stale, so the next pull re-requests
 * the same range and converges (dupes ignored + idempotent rebuild). Returns
 * the number of newly inserted events.
 */
export async function applyPullResponse(
  projectId: string,
  response: SyncPullResponse,
): Promise<number> {
  const inserted = await insertExternalEvents(projectId, response.events);
  await rebuildProjectProjection(projectId);
  if (response.lastRemoteEventId) {
    await updateSyncState(projectId, {
      lastPulledEventId: response.lastRemoteEventId,
      lastSyncAt: nowIso(),
    });
  }
  return inserted;
}

export async function pushProject(
  projectId: string,
  transport: SyncTransport,
): Promise<SyncPushResponse> {
  let state = await readStateOrThrow(projectId);
  if (!state.remoteProjectId) {
    state = await updateSyncState(projectId, {
      remoteProjectId: projectId,
      syncEnabled: true,
      syncStatus: 'syncing',
    });
  } else if (state.syncStatus !== 'syncing') {
    state = await updateSyncState(projectId, { syncStatus: 'syncing' });
  }

  const payload = await buildPushPayload(projectId);
  if (payload.events.length === 0) {
    await updateSyncState(projectId, { syncStatus: 'idle' });
    return { accepted: [], rejected: [] };
  }

  const response = await transport.push(payload);
  if (response.lastAcceptedEventId) {
    await markPushed(projectId, response.lastAcceptedEventId);
  }
  await updateSyncState(projectId, { syncStatus: 'idle' });
  return response;
}

export async function pullProject(
  projectId: string,
  transport: SyncTransport,
): Promise<SyncPullResult> {
  const state = await readStateOrThrow(projectId);
  if (!state.remoteProjectId) {
    throw new Error(
      `Cannot pull: project ${projectId} has no remoteProjectId. Push first to bind the remote.`,
    );
  }
  await updateSyncState(projectId, { syncStatus: 'syncing' });

  const response = await transport.pull({
    projectId,
    remoteProjectId: state.remoteProjectId,
    ...(state.lastPulledEventId
      ? { sincePulledEventId: state.lastPulledEventId }
      : {}),
  });

  let inserted = 0;
  if (response.events.length > 0) {
    inserted = await applyPullResponse(projectId, response);
  }
  await updateSyncState(projectId, { syncStatus: 'idle' });

  return {
    total: response.events.length,
    inserted,
    ...(response.lastRemoteEventId
      ? { lastRemoteEventId: response.lastRemoteEventId }
      : {}),
  };
}

export interface CloneResult {
  /** The adopted (remote) projectId — same on every machine. */
  projectId: string;
  /** Events pulled from the remote during the clone. */
  pulled: number;
}

/**
 * Clone-on-bind (#30, true replica): join a remote project from a FRESH cwd by
 * ADOPTING the remote projectId — never minting a local one. The replica's
 * `projectId === remoteProjectId`; on a different machine it lives under a
 * different MEMORIZE_ROOT (git analog: same SHAs, different working copy).
 *
 * Because the cwd is fresh, there is no local data to migrate and exactly ONE
 * `project.created` (the remote's, at seq 1) ever lands in the store — no
 * identity clobber. This is the fix for the root cause of #30: today B mints
 * its own id (`createProject`) BEFORE binding, so two identities collide in one
 * DB. Clone adopts the id up front instead.
 */
export async function cloneProject(
  cwd: string,
  remoteProjectId: string,
  transport: SyncTransport,
): Promise<CloneResult> {
  assertValidId(remoteProjectId, 'remoteProjectId');

  // Fresh-cwd guard. Bound to the SAME id → idempotent re-pull below. Bound to
  // a DIFFERENT id → refuse: that is a diverged-history merge (#30 follow-up),
  // not a clone. Converting today's SILENT clobber into a loud failure.
  const existing = await resolveProjectIdForPath(cwd);
  if (existing && existing !== remoteProjectId) {
    throw new Error(
      `Directory is already bound to project ${existing}. Clone requires a ` +
        `fresh directory; re-binding existing local history to a remote ` +
        `(diverged-history merge) is not yet supported (#30 follow-up).`,
    );
  }

  if (!existing) {
    // Adopt the remote identity WITHOUT minting a new project. Write the sync
    // state with writeJson — NOT writeState/updateSyncState, which append a
    // `sync.state.updated` event that would become seq 1 and make the first
    // rebuild throw "no project.created". The pull below brings the remote's
    // `project.created` as the first event instead. The pre-seeded
    // remoteProjectId is what lets pullProject pass its own guard.
    await ensureProjectDirectories(remoteProjectId);
    const now = nowIso();
    const initial: ProjectSyncState = {
      id: `sync_${remoteProjectId}`,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
      projectId: remoteProjectId,
      remoteProjectId,
      syncEnabled: true,
      syncStatus: 'idle',
    };
    await writeJson(getSyncFile(remoteProjectId), initial);
    await bindProject(cwd, remoteProjectId);
  }

  const result = await pullProject(remoteProjectId, transport);
  return { projectId: remoteProjectId, pulled: result.inserted };
}

export async function getQueueSnapshot(
  projectId: string,
): Promise<SyncQueueSnapshot> {
  const [state, push] = await Promise.all([
    readStateOrThrow(projectId),
    buildPushPayload(projectId),
  ]);
  return {
    outboundPendingCount: push.events.length,
    ...(state.lastPushedEventId
      ? { lastPushedEventId: state.lastPushedEventId }
      : {}),
    ...(state.lastPulledEventId
      ? { lastPulledEventId: state.lastPulledEventId }
      : {}),
  };
}
