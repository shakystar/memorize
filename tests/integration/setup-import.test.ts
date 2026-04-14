import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-setup-import-'));
  memorizeRoot = join(sandbox, '.memorize-home');
  await mkdir(join(sandbox, '.cursor', 'rules'), { recursive: true });
  await writeFile(
    join(sandbox, 'AGENTS.md'),
    '# Project guidance\nUse small commits and keep handoffs explicit.\n',
    'utf8',
  );
  await writeFile(
    join(sandbox, 'CLAUDE.md'),
    '# Claude guidance\nPrioritize architectural consistency.\n',
    'utf8',
  );
  await writeFile(
    join(sandbox, '.cursor', 'rules', 'coding.mdc'),
    'Always preserve project memory and update docs.',
    'utf8',
  );
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('project setup import', () => {
  it('imports existing context files from an already active project', async () => {
    const setupResult = runCli(['project', 'setup']);
    expect(setupResult.status).toBe(0);
    expect(setupResult.stdout).toContain('Initialized project');
    expect(setupResult.stdout).toContain('Imported context files: 3');

    const showResult = runCli(['project', 'show']);
    expect(showResult.status).toBe(0);
    expect(showResult.stdout).toContain('"importedContextCount": 3');

    const resumeResult = runCli(['task', 'resume']);
    expect(resumeResult.status).toBe(0);
    expect(resumeResult.stdout).toContain('Use small commits and keep handoffs explicit');
    expect(resumeResult.stdout).toContain('Prioritize architectural consistency');
  });
});
