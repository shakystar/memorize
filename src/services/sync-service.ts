import { ACTOR_SYSTEM, nowIso } from '../domain/common.js';
import type { ProjectSyncState } from '../domain/entities.js';
import type {
  SyncPullResponse,
  SyncPullResult,
  SyncPushRequest,
  SyncPushResponse,
  SyncQueueSnapshot,
} from '../domain/sync-protocol.js';
import type { SyncTransport } from '../domain/sync-transport.js';
import {
  appendEvent,
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
