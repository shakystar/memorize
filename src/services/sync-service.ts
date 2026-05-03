import fs from 'node:fs/promises';

import { ACTOR_SYSTEM, nowIso } from '../domain/common.js';
import type { DomainEvent } from '../domain/events.js';
import type { ProjectSyncState } from '../domain/entities.js';
import type {
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
  SyncQueueSnapshot,
} from '../domain/sync-protocol.js';
import type { SyncTransport } from '../domain/sync-transport.js';
import { appendEvent, readEvents } from '../storage/event-store.js';
import { appendLine, isEnoent, readJson, readNdjson, withFileLock, writeJson } from '../storage/fs-utils.js';
import {
  getSyncFile,
  getSyncInboundFile,
} from '../storage/path-resolver.js';

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

function sliceEventsSince(
  events: DomainEvent[],
  sinceEventId: string | undefined,
): DomainEvent[] {
  if (!sinceEventId) {
    return events;
  }
  const index = events.findIndex((event) => event.id === sinceEventId);
  if (index < 0) {
    return events;
  }
  return events.slice(index + 1);
}

export async function buildPushPayload(
  projectId: string,
): Promise<SyncPushRequest> {
  const state = await readStateOrThrow(projectId);
  const events = await readEvents(projectId);
  const pending = sliceEventsSince(events, state.lastPushedEventId).filter(
    (event) => event.type !== 'sync.state.updated',
  );
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

export async function enqueueInbound(
  projectId: string,
  events: DomainEvent[],
): Promise<void> {
  const filePath = getSyncInboundFile(projectId);
  await withFileLock(filePath, async () => {
    for (const event of events) {
      await appendLine(filePath, JSON.stringify(event));
    }
  });
}

export async function drainInbound(
  projectId: string,
): Promise<DomainEvent[]> {
  return readNdjson<DomainEvent>(getSyncInboundFile(projectId), {
    // Skip corrupt lines — may result from interrupted writes
    onCorrupt: () => {},
  });
}

export async function markPulled(
  projectId: string,
  lastRemoteEventId: string,
): Promise<ProjectSyncState> {
  const filePath = getSyncInboundFile(projectId);
  try {
    await fs.writeFile(filePath, '', 'utf8');
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
  }
  return updateSyncState(projectId, {
    lastPulledEventId: lastRemoteEventId,
    lastSyncAt: nowIso(),
  });
}

export async function applyPullResponse(
  projectId: string,
  response: SyncPullResponse,
): Promise<ProjectSyncState> {
  await enqueueInbound(projectId, response.events);
  if (response.lastRemoteEventId) {
    return updateSyncState(projectId, {
      lastPulledEventId: response.lastRemoteEventId,
      lastSyncAt: nowIso(),
    });
  }
  return readStateOrThrow(projectId);
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
): Promise<SyncPullResponse> {
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

  if (response.events.length > 0) {
    await applyPullResponse(projectId, response);
  }
  await updateSyncState(projectId, { syncStatus: 'idle' });
  return response;
}

export async function getQueueSnapshot(
  projectId: string,
): Promise<SyncQueueSnapshot> {
  const [state, push, inbound] = await Promise.all([
    readStateOrThrow(projectId),
    buildPushPayload(projectId),
    drainInbound(projectId),
  ]);
  return {
    outboundPendingCount: push.events.length,
    inboundPendingCount: inbound.length,
    ...(state.lastPushedEventId
      ? { lastPushedEventId: state.lastPushedEventId }
      : {}),
    ...(state.lastPulledEventId
      ? { lastPulledEventId: state.lastPulledEventId }
      : {}),
  };
}
