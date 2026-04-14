import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let sandbox: string;
let memorizeRoot: string;
let fakeBinDir: string;

const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

async function makeFakeCommand(commandName: string): Promise<string> {
  const scriptPath = join(fakeBinDir, commandName);
  const outputPath = join(fakeBinDir, `${commandName}.json`);
  const script = `#!/bin/sh
node -e "const fs=require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify({ argv: process.argv.slice(2), env: { MEMORIZE_STARTUP_CONTEXT: process.env.MEMORIZE_STARTUP_CONTEXT || '', MEMORIZE_PROJECT_ID: process.env.MEMORIZE_PROJECT_ID || '' } }, null, 2));" "${outputPath}" "$@"
`;
  await writeFile(scriptPath, script, 'utf8');
  await chmod(scriptPath, 0o755);
  return outputPath;
}

function runCli(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync('node', [tsxCliPath, cliEntryPath, ...args], {
    cwd: sandbox,
    encoding: 'utf8',
    env: {
      ...process.env,
      MEMORIZE_ROOT: memorizeRoot,
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
      ...extraEnv,
    },
  });
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-launch-'));
  memorizeRoot = join(sandbox, '.memorize-home');
  fakeBinDir = join(sandbox, 'fake-bin');
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(
    join(sandbox, 'AGENTS.md'),
    '# Project guidance\nUse small commits and keep handoffs explicit.\n',
    'utf8',
  );
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('launch integration', () => {
  it('launches claude with appended startup context and auto-setup', async () => {
    const outputPath = await makeFakeCommand('claude');

    const result = runCli(['launch', 'claude']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Launching claude');

    const invocation = JSON.parse(await readFile(outputPath, 'utf8')) as {
      argv: string[];
      env: Record<string, string>;
    };
    expect(invocation.argv).toContain('--append-system-prompt');
    const promptArg = invocation.argv[invocation.argv.indexOf('--append-system-prompt') + 1];
    expect(promptArg).toContain('Use small commits and keep handoffs explicit');
    expect(invocation.env.MEMORIZE_PROJECT_ID).toContain('proj_');
  });

  it('launches codex with startup context as initial prompt and auto-setup', async () => {
    const outputPath = await makeFakeCommand('codex');

    const result = runCli(['launch', 'codex']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Launching codex');

    const invocation = JSON.parse(await readFile(outputPath, 'utf8')) as {
      argv: string[];
      env: Record<string, string>;
    };
    expect(invocation.argv[0]).toContain('Memorize startup context');
    expect(invocation.argv[0]).toContain('Use small commits and keep handoffs explicit');
    expect(invocation.env.MEMORIZE_PROJECT_ID).toContain('proj_');
  });
});
