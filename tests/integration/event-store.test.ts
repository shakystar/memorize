import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProject, createTask } from '../../src/domain/index.js';
import { closeAll } from '../../src/storage/db.js';
import { appendEvent, readEvents } from '../../src/storage/event-store.js';
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
