import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProject, createTask } from '../../src/domain/index.js';
import type { Project, Task } from '../../src/domain/entities.js';
import { appendEvent, readEvents } from '../../src/storage/event-store.js';
import { readJson } from '../../src/storage/fs-utils.js';
import {
  getEventsFile,
  getMemoryIndexFile,
  getProjectFile,
  getTaskFile,
} from '../../src/storage/path-resolver.js';
import { rebuildProjectProjection } from '../../src/services/projection-store.js';

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-storage-test-'));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
  delete process.env.MEMORIZE_ROOT;
});

describe('event store integration', () => {
  it('appends events and rebuilds projections from them', async () => {
    const project = createProject({
      title: 'Memorize',
      rootPath: '/tmp/memorize',
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

    const storedProject = await readJson<Project>(getProjectFile(project.id));
    const storedTask = await readJson<Task>(getTaskFile(project.id, task.id));
    const memoryIndex = await readJson<{ topTasks: Array<{ id: string }> }>(
      getMemoryIndexFile(project.id),
    );
    const eventsFile = await readFile(
      getEventsFile(project.id, new Date().toISOString().slice(0, 10)),
      'utf8',
    );

    expect(storedProject?.id).toBe(project.id);
    expect(storedTask?.id).toBe(task.id);
    expect(memoryIndex?.topTasks[0]?.id).toBe(task.id);
    expect(eventsFile).toContain('"type":"project.created"');
    expect(eventsFile).toContain('"type":"task.created"');
  });
});
