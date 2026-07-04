import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProject } from '../../src/services/project-service.js';
import { createTask, readTask } from '../../src/services/task-service.js';
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
    title: 'Lifecycle project',
    rootPath: sandbox,
  });
  const task = await createTask({
    projectId: project.id,
    title: 'Lifecycle task',
    actor: 'user',
  });
  return { projectId: project.id, taskId: task.id };
}

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), 'memorize-lifecycle-')));
  memorizeRoot = join(sandbox, '.memorize-home');
  process.env.MEMORIZE_ROOT = memorizeRoot;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('memorize task start (status transition to in_progress)', () => {
  it('transitions a todo task to in_progress', async () => {
    const { projectId, taskId } = await seedTask();
    const result = runCli(['task', 'start', taskId]);
    expect(result.status).toBe(0);
    const task = await readTask(projectId, taskId);
    expect(task?.status).toBe('in_progress');
    const parsed = JSON.parse(result.stdout);
    expect(parsed.task.status).toBe('in_progress');
  });

  it('re-grabs the baton: start on a handoff_ready task returns it to in_progress', async () => {
    const { projectId, taskId } = await seedTask();
    expect(runCli(['task', 'start', taskId]).status).toBe(0);
    expect(
      runCli([
        'task', 'handoff', '--task', taskId,
        '--summary', 'x', '--next', 'y',
      ]).status,
    ).toBe(0);
    expect((await readTask(projectId, taskId))?.status).toBe('handoff_ready');
    const result = runCli(['task', 'start', taskId]);
    expect(result.status).toBe(0);
    expect((await readTask(projectId, taskId))?.status).toBe('in_progress');
  });

  it('is an idempotent no-op when already in_progress (no extra event)', async () => {
    const { projectId, taskId } = await seedTask();
    expect(runCli(['task', 'start', taskId]).status).toBe(0);
    const eventsAfterFirst = (await readEvents(projectId)).filter(
      (e) => e.type === 'task.updated',
    ).length;
    expect(runCli(['task', 'start', taskId]).status).toBe(0);
    const eventsAfterSecond = (await readEvents(projectId)).filter(
      (e) => e.type === 'task.updated',
    ).length;
    expect(eventsAfterSecond).toBe(eventsAfterFirst);
    expect((await readTask(projectId, taskId))?.status).toBe('in_progress');
  });

  it('rejects start on a terminal (cancelled) task', async () => {
    const { taskId } = await seedTask();
    expect(runCli(['task', 'cancel', taskId]).status).toBe(0);
    const result = runCli(['task', 'start', taskId]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('cannot start');
  });

  it('supports a standalone start -> done finish (no handoff)', async () => {
    const { projectId, taskId } = await seedTask();
    expect(runCli(['task', 'start', taskId]).status).toBe(0);
    const done = runCli(['task', 'done', '--task', taskId]);
    expect(done.status).toBe(0);
    expect((await readTask(projectId, taskId))?.status).toBe('done');
  });
});

describe('memorize task handoff (strict — requires a started task)', () => {
  it('rejects handoff from a todo task (must start first)', async () => {
    const { taskId } = await seedTask();
    const result = runCli([
      'task', 'handoff', '--task', taskId,
      '--summary', 'x', '--next', 'y',
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('todo -> handoff_ready');
  });

  it('accepts handoff after start (in_progress -> handoff_ready)', async () => {
    const { projectId, taskId } = await seedTask();
    expect(runCli(['task', 'start', taskId]).status).toBe(0);
    const handoff = runCli([
      'task', 'handoff', '--task', taskId,
      '--summary', 'x', '--next', 'y',
    ]);
    expect(handoff.status).toBe(0);
    expect((await readTask(projectId, taskId))?.status).toBe('handoff_ready');
  });

  it('allows an idempotent re-handoff from handoff_ready', async () => {
    const { taskId } = await seedTask();
    expect(runCli(['task', 'start', taskId]).status).toBe(0);
    expect(runCli(['task', 'handoff', '--task', taskId, '--summary', 'a', '--next', 'b']).status).toBe(0);
    const second = runCli(['task', 'handoff', '--task', taskId, '--summary', 'c', '--next', 'd']);
    expect(second.status).toBe(0);
  });
});
