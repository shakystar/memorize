import fs from 'node:fs/promises';
import path from 'node:path';

import type { DomainEvent } from '../domain/events.js';
import type {
  SyncPullRequest,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
} from '../domain/sync-protocol.js';
import type { SyncTransport } from '../domain/sync-transport.js';
import { ensureParentDir, readNdjson, withFileLock } from '../storage/fs-utils.js';

function remoteEventsFile(remoteRoot: string, remoteProjectId: string): string {
  return path.join(remoteRoot, remoteProjectId, 'events.ndjson');
}

export function createFileSyncTransport(remoteRoot: string): SyncTransport {
  return {
    async push(request: SyncPushRequest): Promise<SyncPushResponse> {
      const remoteProjectId = request.remoteProjectId ?? request.projectId;
      const filePath = remoteEventsFile(remoteRoot, remoteProjectId);
      await ensureParentDir(filePath);

      // Auto-sync raises the odds of concurrent pushes to the shared relay
      // file. Serialize the append batch under a cross-process file lock so
      // lines can't interleave. (Residual caveat: mkdir locks over cloud-sync
      // folders are eventually-consistent, not truly atomic — a real HTTP
      // relay in P3-b-2 removes this.)
      const acceptedIds = await withFileLock(filePath, async () => {
        const ids: string[] = [];
        for (const event of request.events) {
          await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, 'utf8');
          ids.push(event.id);
        }
        return ids;
      });

      const lastAcceptedEventId = acceptedIds[acceptedIds.length - 1];
      return {
        accepted: acceptedIds,
        rejected: [],
        ...(lastAcceptedEventId ? { lastAcceptedEventId } : {}),
      };
    },

    async pull(request: SyncPullRequest): Promise<SyncPullResponse> {
      const filePath = remoteEventsFile(remoteRoot, request.remoteProjectId);
      const allEvents = await readNdjson<DomainEvent>(filePath);

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
