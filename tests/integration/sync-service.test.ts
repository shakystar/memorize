import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProject, readSyncState } from '../../src/services/project-service.js';
import { createTask } from '../../src/services/task-service.js';
import {
  applyPullResponse,
  buildPushPayload,
  getQueueSnapshot,
  markPushed,
  pullProject,
  updateSyncState,
} from '../../src/services/sync-service.js';
import type { SyncTransport } from '../../src/domain/sync-transport.js';
import { readEvents } from '../../src/storage/event-store.js';
import type { DomainEvent } from '../../src/domain/events.js';
import { closeAll } from '../../src/storage/db.js';

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-sync-'));
  process.env.MEMORIZE_ROOT = join(sandbox, '.memorize-home');
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('sync service', () => {
  it('builds push payload containing unpushed events and advances cursor after markPushed', async () => {
    const project = await createProject({
      title: 'Sync target',
      rootPath: sandbox,
    });
    await createTask({
      projectId: project.id,
      title: 'Wire sync',
      actor: 'user',
    });
    await createTask({
      projectId: project.id,
      title: 'Serialize payloads',
      actor: 'user',
    });

    const firstPayload = await buildPushPayload(project.id);
    expect(firstPayload.projectId).toBe(project.id);
    expect(firstPayload.sincePushedEventId).toBeUndefined();
    expect(firstPayload.events.length).toBeGreaterThanOrEqual(4);
    expect(firstPayload.events.every((event) => event.type !== 'sync.state.updated')).toBe(
      true,
    );

    const lastEventId = firstPayload.events[firstPayload.events.length - 1]?.id;
    expect(lastEventId).toBeDefined();
    await markPushed(project.id, lastEventId as string);

    const secondPayload = await buildPushPayload(project.id);
    expect(secondPayload.sincePushedEventId).toBe(lastEventId);
    expect(secondPayload.events).toHaveLength(0);
  });

  it('persists remoteProjectId on sync state updates', async () => {
    const project = await createProject({
      title: 'Remote bind',
      rootPath: sandbox,
    });

    const next = await updateSyncState(project.id, {
      remoteProjectId: 'remote-abc',
      syncEnabled: true,
    });

    expect(next.remoteProjectId).toBe('remote-abc');
    expect(next.syncEnabled).toBe(true);

    const payload = await buildPushPayload(project.id);
    expect(payload.remoteProjectId).toBe('remote-abc');
  });

  it('applyPullResponse inserts pulled events into the store and is idempotent', async () => {
    const project = await createProject({
      title: 'Pull target',
      rootPath: sandbox,
    });

    const response = {
      events: [
        {
          id: 'evt_remote_9',
          schemaVersion: '1.0.0',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          type: 'task.created',
          projectId: project.id,
          scopeType: 'task',
          scopeId: 'task_remote_9',
          actor: 'remote-user',
          payload: { id: 'task_remote_9', title: 'Remote task' } as never,
        },
      ] as DomainEvent[],
      lastRemoteEventId: 'evt_remote_9',
    };

    const inserted = await applyPullResponse(project.id, response);
    expect(inserted).toBe(1);

    const ids = (await readEvents(project.id)).map((e) => e.id);
    expect(ids).toContain('evt_remote_9');

    const state = await readSyncState(project.id);
    expect(state?.lastPulledEventId).toBe('evt_remote_9');

    const again = await applyPullResponse(project.id, response);
    expect(again).toBe(0);
  });

  it('getQueueSnapshot reports outbound pending count', async () => {
    const project = await createProject({
      title: 'Snapshot project',
      rootPath: sandbox,
    });

    const initialSnapshot = await getQueueSnapshot(project.id);
    expect(initialSnapshot.outboundPendingCount).toBeGreaterThan(0);
  });

  it('pullProject appends zero events when the remote has nothing new (Critical-2a)', async () => {
    const project = await createProject({
      title: 'No-op pull target',
      rootPath: sandbox,
    });
    await updateSyncState(project.id, {
      remoteProjectId: project.id,
      syncEnabled: true,
    });

    const emptyTransport: SyncTransport = {
      push: async () => ({ accepted: [], rejected: [] }),
      pull: async () => ({ events: [] }),
    };

    const before = await readEvents(project.id);
    const beforeState = await readSyncState(project.id);
    expect(beforeState?.syncStatus).toBe('idle');

    const result = await pullProject(project.id, emptyTransport);
    expect(result).toEqual({ total: 0, inserted: 0 });

    const after = await readEvents(project.id);
    // No sync.state.updated for a 'syncing' flip on the way in, and none for
    // an 'idle' flip on the way out — the pull found nothing, so it writes
    // nothing. This is the fix for the watcher's per-tick churn (Critical-2)
    // and the dead SoT-043 idle gate it caused.
    expect(after.length).toBe(before.length);
    expect((await readSyncState(project.id))?.syncStatus).toBe('idle');
  });
});
