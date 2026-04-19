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

  it('routes checkpoint sentences to task workflow', () => {
    runCli(['do', 'Set this project up for Claude and Codex collaboration']);
    runCli(['do', 'Create a task for auth cleanup']);

    const checkpointResult = runCli([
      'do',
      'Checkpoint progress on auth cleanup',
    ]);
    expect(checkpointResult.status).toBe(0);
    expect(checkpointResult.stdout).toContain('Created checkpoint');
  });

  it('returns guidance when handoff sentence is missing structured fields', () => {
    runCli(['do', 'Set this project up for Claude and Codex collaboration']);
    runCli(['do', 'Create a task for auth cleanup']);

    const handoffResult = runCli(['do', 'Hand off the work to Codex']);
    expect(handoffResult.status).toBe(0);
    expect(handoffResult.stdout).toContain('Handoff requires --next');
    expect(handoffResult.stdout).toContain('intent, context, and decisions');
  });

  it('creates a handoff via "do" when sentence is combined with flags', () => {
    runCli(['do', 'Set this project up for Claude and Codex collaboration']);
    runCli(['do', 'Create a task for auth cleanup']);

    const handoffResult = runCli([
      'do',
      'Hand off the work to Codex',
      '--summary',
      'OAuth refresh scope narrowed',
      '--next',
      'Receiving agent verifies refresh token env var and runs integration tests',
      '--done',
      'token store schema',
      '--remaining',
      'env var doc',
      '--confidence',
      'medium',
    ]);
    expect(handoffResult.status).toBe(0);
    expect(handoffResult.stdout).toContain('Created handoff');
    expect(handoffResult.stdout).toContain('→ codex');
    expect(handoffResult.stdout).toContain(
      'Handoff records intent, context, and decisions only',
    );
  });

  it('launches interactive mode menu when "do" is invoked with no arguments', () => {
    const result = spawnSync('node', [tsxCliPath, cliEntryPath, 'do'], {
      cwd: sandbox,
      encoding: 'utf8',
      input: 'q\n',
      env: {
        ...process.env,
        MEMORIZE_ROOT: memorizeRoot,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Memorize interactive mode');
    expect(result.stdout).toContain('1) handoff');
    expect(result.stdout).toContain('2) checkpoint');
    expect(result.stdout).toContain('Cancelled');
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
