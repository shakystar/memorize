import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

let sandbox: string;
let memorizeRoot: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-init-guard-'));
  memorizeRoot = join(sandbox, '.memorize-home');
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

function runInit(
  extraArgs: string[] = [],
  cwd: string = sandbox,
): SpawnSyncReturns<string> {
  return spawnSync(
    'node',
    [tsxCliPath, cliEntryPath, 'project', 'init', ...extraArgs],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, MEMORIZE_ROOT: memorizeRoot },
    },
  );
}

describe('project init guard', () => {
  it('succeeds the first time in a fresh directory', () => {
    const result = runInit();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Initialized project');
  });

  it('refuses to re-init a directory that is already bound', () => {
    const first = runInit();
    expect(first.status).toBe(0);

    const second = runInit();
    expect(second.status).not.toBe(0);
    expect(second.stderr).toContain('already bound');
    expect(second.stderr).toContain('project setup');
    expect(second.stderr).toContain('--force');
  });

  it('overwrites the binding when --force is passed', () => {
    const first = runInit();
    expect(first.status).toBe(0);
    const firstId = first.stdout.match(/\(proj_[^)]+\)/)?.[0];

    const second = runInit(['--force']);
    expect(second.status).toBe(0);
    const secondId = second.stdout.match(/\(proj_[^)]+\)/)?.[0];

    expect(firstId).toBeDefined();
    expect(secondId).toBeDefined();
    expect(secondId).not.toBe(firstId);
  });
});
