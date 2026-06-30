import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProject, createTask } from '../../src/domain/index.js';
import type { DomainEvent } from '../../src/domain/events.js';
import { closeAll } from '../../src/storage/db.js';
import {
  appendEvent,
  insertExternalEvents,
  readEvents,
} from '../../src/storage/event-store.js';
import {
  getMemoryIndex,
  getProjectProjection,
  getTask,
  rebuildProjectProjection,
} from '../../src/services/projection-store.js';

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-storage-test-'));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  closeAll();
  await rm(sandbox, { recursive: true, force: true });
  delete process.env.MEMORIZE_ROOT;
});

describe('event store integration', () => {
  it('appends events and rebuilds projections from them', async () => {
    const project = createProject({
      title: 'Memorize',
      rootPath: join(tmpdir(), 'memorize-test-event-store'),
      summary: 'Shared context system',
    });
    const task = createTask({
      projectId: project.id,
      workstreamId: 'ws_default',
      title: 'Implement event store',
      priority: 'high',
    });

    await appendEvent({
      type: 'project.created',
      projectId: project.id,
      scopeType: 'project',
      scopeId: project.id,
      actor: 'test',
      payload: project,
    });
    await appendEvent({
      type: 'task.created',
      projectId: project.id,
      scopeType: 'task',
      scopeId: task.id,
      actor: 'test',
      payload: task,
    });

    const events = await readEvents(project.id);
    expect(events).toHaveLength(2);

    await rebuildProjectProjection(project.id);

    const storedProject = getProjectProjection(project.id);
    const storedTask = getTask(project.id, task.id);
    const memoryIndex = getMemoryIndex(project.id);

    expect(storedProject?.id).toBe(project.id);
    expect(storedTask?.id).toBe(task.id);
    expect(memoryIndex?.topTasks[0]?.id).toBe(task.id);
    // Events now live in SQLite (seq order), not dated NDJSON files.
    expect(events.map((event) => event.type)).toEqual([
      'project.created',
      'task.created',
    ]);
  });
});

// 3.0.0 Phase 0: per-event provenance is captured on append and preserved across
// sync, but unconsumed — these tests pin the write/round-trip behavior only.
describe('event provenance (Phase 0)', () => {
  it('local append defaults writer to actor and source to the project', async () => {
    const projectId = 'proj_prov_local01';
    const task = createTask({
      projectId,
      workstreamId: 'ws_default',
      title: 'provenance task',
      priority: 'high',
    });
    await appendEvent({
      type: 'task.created',
      projectId,
      scopeType: 'task',
      scopeId: task.id,
      actor: 'agent-a',
      payload: task,
    });

    const [event] = await readEvents(projectId);
    expect(event?.writer).toBe('agent-a');
    expect(event?.sourceProjectId).toBe(projectId);
  });

  it('preserves foreign provenance verbatim on external (synced) events', async () => {
    const projectId = 'proj_prov_ext01';
    const foreign: DomainEvent = {
      id: 'evt_foreign_1',
      schemaVersion: '0.1.0',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      type: 'task.created',
      projectId,
      scopeType: 'task',
      scopeId: 'task_y',
      actor: 'bob',
      writer: 'account_bob',
      sourceProjectId: 'proj_bob_origin',
      payload: { id: 'task_y' },
    };

    const inserted = await insertExternalEvents(projectId, [foreign]);
    expect(inserted).toBe(1);

    const [event] = await readEvents(projectId);
    // NOT overwritten with the local self — the remote's identity survives.
    expect(event?.writer).toBe('account_bob');
    expect(event?.sourceProjectId).toBe('proj_bob_origin');
  });

  it('reads NULL provenance back as absent (legacy / pre-3.0.0 event)', async () => {
    const projectId = 'proj_prov_legacy01';
    const legacy: DomainEvent = {
      id: 'evt_legacy_1',
      schemaVersion: '0.1.0',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      type: 'task.created',
      projectId,
      scopeType: 'task',
      scopeId: 'task_z',
      actor: 'system',
      payload: { id: 'task_z' },
    };

    await insertExternalEvents(projectId, [legacy]);

    const [event] = await readEvents(projectId);
    expect(event?.writer).toBeUndefined();
    expect(event?.sourceProjectId).toBeUndefined();
  });
});
