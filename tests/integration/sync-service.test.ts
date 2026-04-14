import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProject } from '../../src/services/project-service.js';
import { createTask } from '../../src/services/task-service.js';
import {
  applyPullResponse,
  buildPushPayload,
  drainInbound,
  enqueueInbound,
  getQueueSnapshot,
  markPulled,
  markPushed,
  updateSyncState,
} from '../../src/services/sync-service.js';
import type { DomainEvent } from '../../src/domain/events.js';

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-sync-'));
  process.env.MEMORIZE_ROOT = join(sandbox, '.memorize-home');
});

afterEach(async () => {
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

  it('enqueues inbound events and drains them after markPulled', async () => {
    const project = await createProject({
      title: 'Inbound target',
      rootPath: sandbox,
    });

    const fakeEvents: DomainEvent[] = [
      {
        id: 'evt_remote_1',
        schemaVersion: '1.0.0',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        type: 'task.updated',
        projectId: project.id,
        scopeType: 'task',
        scopeId: 'task_remote_1',
        actor: 'remote-user',
        payload: { status: 'in_progress' },
      },
      {
        id: 'evt_remote_2',
        schemaVersion: '1.0.0',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        type: 'task.updated',
        projectId: project.id,
        scopeType: 'task',
        scopeId: 'task_remote_1',
        actor: 'remote-user',
        payload: { status: 'done' },
      },
    ];

    await enqueueInbound(project.id, fakeEvents);
    const drained = await drainInbound(project.id);
    expect(drained).toHaveLength(2);
    expect(drained[0]?.id).toBe('evt_remote_1');

    await markPulled(project.id, 'evt_remote_2');
    const afterPull = await drainInbound(project.id);
    expect(afterPull).toHaveLength(0);

    const snapshot = await getQueueSnapshot(project.id);
    expect(snapshot.lastPulledEventId).toBe('evt_remote_2');
    expect(snapshot.inboundPendingCount).toBe(0);
  });

  it('applyPullResponse enqueues and advances lastPulledEventId', async () => {
    const project = await createProject({
      title: 'Pull target',
      rootPath: sandbox,
    });

    const state = await applyPullResponse(project.id, {
      events: [
        {
          id: 'evt_remote_9',
          schemaVersion: '1.0.0',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          type: 'decision.proposed',
          projectId: project.id,
          scopeType: 'project',
          scopeId: project.id,
          actor: 'remote-user',
          payload: { id: 'dec_1' } as never,
        },
      ],
      lastRemoteEventId: 'evt_remote_9',
    });

    expect(state.lastPulledEventId).toBe('evt_remote_9');
    const inbound = await drainInbound(project.id);
    expect(inbound).toHaveLength(1);
    expect(inbound[0]?.id).toBe('evt_remote_9');
  });

  it('getQueueSnapshot reports outbound and inbound pending counts', async () => {
    const project = await createProject({
      title: 'Snapshot project',
      rootPath: sandbox,
    });

    const initialSnapshot = await getQueueSnapshot(project.id);
    expect(initialSnapshot.outboundPendingCount).toBeGreaterThan(0);
    expect(initialSnapshot.inboundPendingCount).toBe(0);
  });
});
