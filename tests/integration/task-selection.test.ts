import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProject } from '../../src/services/project-service.js';
import { createTask, updateTask } from '../../src/services/task-service.js';
import { loadStartContext } from '../../src/services/context-service.js';

let sandbox: string;
let memorizeRoot: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-task-selection-'));
  memorizeRoot = join(sandbox, '.memorize-home');
  process.env.MEMORIZE_ROOT = memorizeRoot;
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
  delete process.env.MEMORIZE_ROOT;
});

describe('task selection', () => {
  it('prefers in-progress tasks over todo tasks when no explicit task is requested', async () => {
    const project = await createProject({
      title: 'Selection project',
      rootPath: sandbox,
    });
    const todoTask = await createTask({
      projectId: project.id,
      title: 'Todo task',
      actor: 'user',
    });
    const activeTask = await createTask({
      projectId: project.id,
      title: 'Active task',
      actor: 'user',
    });

    await updateTask(project.id, activeTask.id, { status: 'in_progress' }, 'user');

    const startup = await loadStartContext({ projectId: project.id });
    expect(startup.task?.id).toBe(activeTask.id);
    expect(startup.task?.id).not.toBe(todoTask.id);
  });
});
