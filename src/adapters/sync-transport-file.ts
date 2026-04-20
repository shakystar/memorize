import fs from 'node:fs/promises';
import path from 'node:path';

import type { DomainEvent } from '../domain/events.js';
import type {
  SyncPullRequest,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
} from '../domain/sync-protocol.js';
import { isEnoent } from '../storage/fs-utils.js';
import type { SyncTransport } from '../services/sync-transport.js';

function remoteEventsFile(remoteRoot: string, remoteProjectId: string): string {
  return path.join(remoteRoot, remoteProjectId, 'events.ndjson');
}

async function readAllRemoteEvents(
  filePath: string,
): Promise<DomainEvent[]> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as DomainEvent);
  } catch (error) {
    if (isEnoent(error)) {
      return [];
    }
    throw error;
  }
}

export function createFileSyncTransport(remoteRoot: string): SyncTransport {
  return {
    async push(request: SyncPushRequest): Promise<SyncPushResponse> {
      const remoteProjectId = request.remoteProjectId ?? request.projectId;
      const filePath = remoteEventsFile(remoteRoot, remoteProjectId);
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      const acceptedIds: string[] = [];
      for (const event of request.events) {
        await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, 'utf8');
        acceptedIds.push(event.id);
      }

      const lastAcceptedEventId = acceptedIds[acceptedIds.length - 1];
      return {
        accepted: acceptedIds,
        rejected: [],
        ...(lastAcceptedEventId ? { lastAcceptedEventId } : {}),
      };
    },

    async pull(request: SyncPullRequest): Promise<SyncPullResponse> {
      const filePath = remoteEventsFile(remoteRoot, request.remoteProjectId);
      const allEvents = await readAllRemoteEvents(filePath);

      const sliceStart = request.sincePulledEventId
        ? allEvents.findIndex(
            (event) => event.id === request.sincePulledEventId,
          ) + 1
        : 0;
      const pending = sliceStart > 0 ? allEvents.slice(sliceStart) : allEvents;

      const lastRemoteEventId = pending[pending.length - 1]?.id;
      return {
        events: pending,
        ...(lastRemoteEventId ? { lastRemoteEventId } : {}),
      };
    },
  };
}
