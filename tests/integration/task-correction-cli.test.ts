import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProject } from '../../src/services/project-service.js';
import { createTask, readTask } from '../../src/services/task-service.js';
import { getProjectProjection } from '../../src/services/projection-store.js';
import { readEvents } from '../../src/storage/event-store.js';
import { closeAll } from '../../src/storage/db.js';

let sandbox: string;
let memorizeRoot: string;

const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

function runCli(args: string[]) {
  return spawnSync(process.execPath, [tsxCliPath, cliEntryPath, ...args], {
    cwd: sandbox,
    encoding: 'utf8',
    env: { ...process.env, MEMORIZE_ROOT: memorizeRoot },
  });
}

async function seedTask(): Promise<{ projectId: string; taskId: string }> {
  const project = await createProject({
    title: 'Correction project',
    rootPath: sandbox,
  });
  const task = await createTask({
    projectId: project.id,
    title: 'Original title',
    actor: 'user',
  });
  return { projectId: project.id, taskId: task.id };
}

beforeEach(async () => {
  // macOS os.tmpdir() is a symlink (/var -> /private/var); canonicalize so the
  // path we bind in-process matches the realpath the spawned CLI sees as cwd.
  sandbox = await realpath(await mkdtemp(join(tmpdir(), 'memorize-task-correction-')));
  memorizeRoot = join(sandbox, '.memorize-home');
  process.env.MEMORIZE_ROOT = memorizeRoot;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('memorize task update (append-only correction)', () => {
  it('appends task.updated with the new title/description; original task.created survives', async () => {
    const { projectId, taskId } = await seedTask();
    const before = await readEvents(projectId);
    const createdCountBefore = before.filter(
      (e) => e.type === 'task.created',
    ).length;
    expect(createdCountBefore).toBe(1);

    const result = runCli([
      'task',
      'update',
      taskId,
      '--title',
      'New title',
      '--note',
      'New note',
    ]);
    expect(result.status).toBe(0);

    const task = await readTask(projectId, taskId);
    expect(task?.title).toBe('New title');
    expect(task?.description).toBe('New note');

    const after = await readEvents(projectId);
    // Append-only: created is still present, an updated event was added.
    expect(after.filter((e) => e.type === 'task.created').length).toBe(1);
    expect(after.filter((e) => e.type === 'task.updated').length).toBe(1);
    expect(after.length).toBe(before.length + 1);
  });

  it('rejects update with no --title and no --note', async () => {
    const { taskId } = await seedTask();
    const result = runCli(['task', 'update', taskId]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--title|--note/i);
  });
});

describe('memorize task cancel (append-only tombstone)', () => {
  it('moves the task to cancelled, drops it from activeTaskIds, and appends an event', async () => {
    const { projectId, taskId } = await seedTask();
    const before = await readEvents(projectId);

    const result = runCli(['task', 'cancel', taskId]);
    expect(result.status).toBe(0);

    const task = await readTask(projectId, taskId);
    expect(task?.status).toBe('cancelled');

    const project = getProjectProjection(projectId);
    expect(project?.activeTaskIds).not.toContain(taskId);

    const after = await readEvents(projectId);
    // Append-only: nothing deleted, exactly one event appended.
    expect(after.length).toBe(before.length + 1);
    expect(after.filter((e) => e.type === 'task.created').length).toBe(1);
  });

  it('refuses to cancel a done task (done is terminal success)', async () => {
    const { projectId, taskId } = await seedTask();
    // Drive to done via the legal path.
    expect(runCli(['task', 'update', taskId, '--title', 'x']).status).toBe(0);
    // status path: todo -> in_progress -> handoff_ready -> done
    const { updateTask } = await import('../../src/services/task-service.js');
    await updateTask(projectId, taskId, { status: 'in_progress' }, 'user');
    await updateTask(projectId, taskId, { status: 'handoff_ready' }, 'user');
    await updateTask(projectId, taskId, { status: 'done' }, 'user');

    const result = runCli(['task', 'cancel', taskId]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/invalid task status transition|done -> cancelled/i);
  });
});
