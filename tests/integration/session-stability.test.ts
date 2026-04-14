import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

let sandbox: string;
let memorizeRoot: string;

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> {
  return spawnSync('node', [tsxCliPath, cliEntryPath, ...args], {
    cwd: sandbox,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
      MEMORIZE_ROOT: memorizeRoot,
    },
  });
}

function parseCheckpointId(stdout: string): string {
  const match = stdout.match(/Created checkpoint (\S+)/);
  if (!match?.[1]) throw new Error(`No checkpoint id in output: ${stdout}`);
  return match[1];
}

function stdoutOf(result: ReturnType<typeof spawnSync>): string {
  return String(result.stdout ?? '');
}

async function readProjectIdFromShow(): Promise<string> {
  const show = runCli(['project', 'show']);
  return (JSON.parse(stdoutOf(show)) as { id: string }).id;
}

async function readCheckpointSession(
  projectId: string,
  checkpointId: string,
): Promise<string | undefined> {
  const filePath = join(
    memorizeRoot,
    'projects',
    projectId,
    'checkpoints',
    `${checkpointId}.json`,
  );
  const raw = await readFile(filePath, 'utf8');
  return (JSON.parse(raw) as { sessionId?: string }).sessionId;
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-session-'));
  memorizeRoot = join(sandbox, '.memorize-home');
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('session id stability', () => {
  it('reuses the same sessionId across multiple checkpoints when env var is set', async () => {
    expect(runCli(['project', 'init']).status).toBe(0);
    expect(runCli(['task', 'create', 'Session test']).status).toBe(0);

    const envSessionId = 'session_env_fixed';

    const first = runCli(
      ['task', 'checkpoint', '--summary', 'first checkpoint'],
      { MEMORIZE_SESSION_ID: envSessionId },
    );
    expect(first.status).toBe(0);
    const firstId = parseCheckpointId(stdoutOf(first));

    const second = runCli(
      ['task', 'checkpoint', '--summary', 'second checkpoint'],
      { MEMORIZE_SESSION_ID: envSessionId },
    );
    expect(second.status).toBe(0);
    const secondId = parseCheckpointId(stdoutOf(second));

    const projectId = await readProjectIdFromShow();
    const firstSession = await readCheckpointSession(projectId, firstId);
    const secondSession = await readCheckpointSession(projectId, secondId);

    expect(firstSession).toBe(envSessionId);
    expect(secondSession).toBe(envSessionId);
  });

  it('reuses the same sessionId across checkpoints via ambient .memorize/current-session.json', async () => {
    expect(runCli(['project', 'init']).status).toBe(0);
    expect(runCli(['task', 'create', 'Ambient session test']).status).toBe(0);

    const first = runCli(['task', 'checkpoint', '--summary', 'first ambient']);
    expect(first.status).toBe(0);
    const firstId = parseCheckpointId(stdoutOf(first));

    const second = runCli([
      'task',
      'checkpoint',
      '--summary',
      'second ambient',
    ]);
    expect(second.status).toBe(0);
    const secondId = parseCheckpointId(stdoutOf(second));

    const projectId = await readProjectIdFromShow();
    const firstSession = await readCheckpointSession(projectId, firstId);
    const secondSession = await readCheckpointSession(projectId, secondId);

    expect(firstSession).toBeDefined();
    expect(secondSession).toBe(firstSession);
  });
});
