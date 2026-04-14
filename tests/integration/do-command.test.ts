import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-phase34-'));
  memorizeRoot = join(sandbox, '.memorize-home');
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('do command', () => {
  it('supports project bootstrap and task creation through sentence commands', () => {
    const initResult = runCli(['do', 'Set this project up for Claude and Codex collaboration']);
    expect(initResult.status).toBe(0);
    expect(initResult.stdout).toContain('Initialized project');

    const taskResult = runCli(['do', 'Create a task for auth cleanup']);
    expect(taskResult.status).toBe(0);
    expect(taskResult.stdout).toContain('Created task');

    const summaryResult = runCli(['do', 'Summarize project status']);
    expect(summaryResult.status).toBe(0);
    expect(summaryResult.stdout).toContain('Workflow: summarize_project_status');
  });

  it('routes checkpoint and handoff sentences to task workflows', () => {
    runCli(['do', 'Set this project up for Claude and Codex collaboration']);
    runCli(['do', 'Create a task for auth cleanup']);

    const checkpointResult = runCli([
      'do',
      'Checkpoint progress on auth cleanup',
    ]);
    expect(checkpointResult.status).toBe(0);
    expect(checkpointResult.stdout).toContain('Created checkpoint');

    const handoffResult = runCli(['do', 'Hand off the work to Codex']);
    expect(handoffResult.status).toBe(0);
    expect(handoffResult.stdout).toContain('Created handoff');
    expect(handoffResult.stdout).toContain('codex');
  });

  it('routes bind adapter sentences through the install service', () => {
    runCli(['do', 'Set this project up for Claude and Codex collaboration']);

    const bindClaude = runCli(['do', 'Bind the Claude adapter']);
    expect(bindClaude.status).toBe(0);
    expect(bindClaude.stdout).toContain('Bound Claude adapter');

    const bindCodex = runCli(['do', 'Install the Codex adapter']);
    expect(bindCodex.status).toBe(0);
    expect(bindCodex.stdout).toContain('Bound Codex adapter');
  });
});
