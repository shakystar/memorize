import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProject } from '../../src/services/project-service.js';
import { createTask, readTask } from '../../src/services/task-service.js';
import { loadStartContext } from '../../src/services/context-service.js';
import { readJson } from '../../src/storage/fs-utils.js';
import { getSyncFile } from '../../src/storage/path-resolver.js';
import type { ProjectSyncState } from '../../src/domain/entities.js';

let sandbox: string;
let memorizeRoot: string;
const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

function runCli(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync('node', [tsxCliPath, cliEntryPath, ...args], {
    cwd: sandbox,
    encoding: 'utf8',
    env: {
      ...process.env,
      MEMORIZE_ROOT: memorizeRoot,
    },
  });
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-phase2-'));
  memorizeRoot = join(sandbox, '.memorize-home');
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('phase 2 services and cli', () => {
  it('creates project/task via services and loads startup context', async () => {
    const project = await createProject({
      title: 'Memorize',
      rootPath: sandbox,
      summary: 'Shared context system',
    });
    const task = await createTask({
      projectId: project.id,
      title: 'Implement services',
      actor: 'codex',
    });

    const storedTask = await readTask(project.id, task.id);
    const startup = await loadStartContext({
      projectId: project.id,
      taskId: task.id,
    });

    expect(storedTask?.title).toBe('Implement services');
    expect(startup.task?.id).toBe(task.id);
    expect(startup.projectSummary).toBe('Shared context system');
  });

  it('supports thin cli commands for project and task flows', () => {
    const init = runCli(['project', 'init']);
    expect(init.status).toBe(0);
    expect(init.stdout).toContain('Initialized project');

    const showProject = runCli(['project', 'show']);
    expect(showProject.status).toBe(0);
    expect(showProject.stdout).toContain('"title"');

    const createTaskResult = runCli(['task', 'create', 'Create', 'a', 'task']);
    expect(createTaskResult.status).toBe(0);
    expect(createTaskResult.stdout).toContain('Created task');

    const resumeResult = runCli(['task', 'resume']);
    expect(resumeResult.status).toBe(0);
    expect(resumeResult.stdout).toContain('"projectSummary"');

    const syncResult = runCli(['project', 'sync']);
    expect(syncResult.status).toBe(0);
    expect(syncResult.stdout).toContain('Project sync state');
  });

  it('records task checkpoint and handoff via cli', () => {
    const init = runCli(['project', 'init']);
    expect(init.status).toBe(0);

    const createTaskResult = runCli(['task', 'create', 'Finish', 'wiring']);
    expect(createTaskResult.status).toBe(0);

    const checkpoint = runCli([
      'task',
      'checkpoint',
      '--summary',
      'Halfway through wiring',
      '--task-update',
      'flag parser added',
      '--deferred',
      'polish error messages',
    ]);
    expect(checkpoint.status).toBe(0);
    expect(checkpoint.stdout).toContain('Created checkpoint');

    const handoff = runCli([
      'task',
      'handoff',
      '--summary',
      'Ready for codex',
      '--next',
      'Continue from handoff notes',
      '--done',
      'cli stubs replaced',
      '--remaining',
      'add golden tests',
      '--confidence',
      'high',
    ]);
    expect(handoff.status).toBe(0);
    expect(handoff.stdout).toContain('Created handoff');
  });

  it('rejects task handoff when required flags are missing', () => {
    runCli(['project', 'init']);
    runCli(['task', 'create', 'Missing flags test']);

    const missingNext = runCli([
      'task',
      'handoff',
      '--summary',
      'no next action',
    ]);
    expect(missingNext.status).not.toBe(0);
    expect(missingNext.stderr).toContain('--next is required');
  });

  it('creates a project-scoped sync metadata file during initialization', async () => {
    const project = await createProject({
      title: 'Memorize',
      rootPath: sandbox,
      summary: 'Shared context system',
    });

    const syncState = await readJson<ProjectSyncState>(getSyncFile(project.id));
    expect(syncState?.projectId).toBe(project.id);
    expect(syncState?.syncEnabled).toBe(false);
    expect(syncState?.syncStatus).toBe('idle');
  });

  it('lists tasks with optional status filter', () => {
    expect(runCli(['project', 'init']).status).toBe(0);
    expect(runCli(['task', 'create', 'Alpha task']).status).toBe(0);
    expect(runCli(['task', 'create', 'Beta task']).status).toBe(0);

    const listAll = runCli(['task', 'list']);
    expect(listAll.status).toBe(0);
    expect(listAll.stdout).toContain('Alpha task');
    expect(listAll.stdout).toContain('Beta task');
    expect(listAll.stdout).toContain('todo');

    const listTodo = runCli(['task', 'list', '--status', 'todo']);
    expect(listTodo.status).toBe(0);
    expect(listTodo.stdout).toContain('Alpha task');

    const listDone = runCli(['task', 'list', '--status', 'done']);
    expect(listDone.status).toBe(0);
    expect(listDone.stdout).toContain('No tasks found');

    const invalid = runCli(['task', 'list', '--status', 'unknown']);
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain('--status must be one of');
  });
});
