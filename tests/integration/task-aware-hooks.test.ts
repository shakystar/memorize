import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let sandbox: string;
let memorizeRoot: string;

const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

function runCli(args: string[]) {
  return spawnSync('node', [tsxCliPath, cliEntryPath, ...args], {
    cwd: sandbox,
    encoding: 'utf8',
    env: {
      ...process.env,
      MEMORIZE_ROOT: memorizeRoot,
    },
  });
}

function runHook(eventName: string, stdinPayload: object) {
  return spawnSync('node', [tsxCliPath, cliEntryPath, 'hook', 'claude', eventName], {
    cwd: sandbox,
    input: JSON.stringify(stdinPayload),
    encoding: 'utf8',
    env: {
      ...process.env,
      MEMORIZE_ROOT: memorizeRoot,
    },
  });
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-task-aware-hook-'));
  memorizeRoot = join(sandbox, '.memorize-home');
  await mkdir(join(sandbox, '.cursor', 'rules'), { recursive: true });
  await writeFile(join(sandbox, 'AGENTS.md'), '# Project guidance\nUse small commits.\n', 'utf8');
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('task-aware hook semantics', () => {
  it('attaches PostCompact checkpoints to the current active task', async () => {
    runCli(['project', 'setup']);
    const createTask = runCli(['task', 'create', 'Wire', 'task-aware', 'checkpoint']);
    expect(createTask.status).toBe(0);

    const result = runHook('PostCompact', {
      cwd: sandbox,
      hook_event_name: 'PostCompact',
      session_id: 'session_task_1',
      compact_summary: 'Task-aware compact summary',
    });
    expect(result.status).toBe(0);

    const projectDirs = await readdir(join(memorizeRoot, 'projects'));
    const taskFiles = await readdir(join(memorizeRoot, 'projects', projectDirs[0]!, 'tasks'));
    const taskContent = await readFile(
      join(memorizeRoot, 'projects', projectDirs[0]!, 'tasks', taskFiles[0]!),
      'utf8',
    );

    expect(taskContent).toContain('latestCheckpointId');
  });

  it('attaches Stop handoffs to the current active task', async () => {
    runCli(['project', 'setup']);
    runCli(['task', 'create', 'Wire', 'task-aware', 'handoff']);

    const result = runHook('Stop', {
      cwd: sandbox,
      hook_event_name: 'Stop',
      session_id: 'session_task_2',
      last_assistant_message: 'Task-aware stop summary',
    });
    expect(result.status).toBe(0);

    const projectDirs = await readdir(join(memorizeRoot, 'projects'));
    const taskFiles = await readdir(join(memorizeRoot, 'projects', projectDirs[0]!, 'tasks'));
    const taskContent = await readFile(
      join(memorizeRoot, 'projects', projectDirs[0]!, 'tasks', taskFiles[0]!),
      'utf8',
    );

    expect(taskContent).toContain('latestHandoffId');
    expect(taskContent).toContain('handoff_ready');
  });
});
