import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

async function makeFakeCodex(): Promise<string> {
  const scriptPath = join(fakeBinDir, 'codex');
  const outputPath = join(fakeBinDir, 'codex.json');
  const script = `#!/bin/sh
OUT=
for i in "$@"; do
  if [ "$PREV" = "--output-last-message" ]; then OUT="$i"; fi
  PREV="$i"
done
if [ -n "$OUT" ]; then
  printf 'Codex generated last message for Memorize\\n' > "$OUT"
fi
node -e "const fs=require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify({ argv: process.argv.slice(2) }, null, 2));" "${outputPath}" "$@"
`;
  await writeFile(scriptPath, script, 'utf8');
  await chmod(scriptPath, 0o755);
  return outputPath;
}

function runCli(args: string[]) {
  return spawnSync('node', [tsxCliPath, cliEntryPath, ...args], {
    cwd: sandbox,
    encoding: 'utf8',
    env: {
      ...process.env,
      MEMORIZE_ROOT: memorizeRoot,
      MEMORIZE_CODEX_BIN: join(fakeBinDir, 'codex'),
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
    },
  });
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-codex-lifecycle-'));
  memorizeRoot = join(sandbox, '.memorize-home');
  fakeBinDir = join(sandbox, 'fake-bin');
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(join(sandbox, 'AGENTS.md'), '# Guidance\nUse small commits.\n', 'utf8');
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('codex lifecycle companion flow', () => {
  it('captures codex last-message output and turns it into a checkpoint artifact', async () => {
    await makeFakeCodex();
    runCli(['project', 'setup']);
    runCli(['task', 'create', 'Create', 'codex', 'task']);

    const result = runCli(['launch', 'codex', '--', 'exec']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Launching codex');

    const projectDirs = await readdir(join(memorizeRoot, 'projects'));
    const checkpointsDir = join(memorizeRoot, 'projects', projectDirs[0]!, 'checkpoints');
    const checkpointFiles = await readdir(checkpointsDir);
    expect(checkpointFiles.length).toBeGreaterThan(0);

    const checkpoint = await readFile(join(checkpointsDir, checkpointFiles[0]!), 'utf8');
    expect(checkpoint).toContain('Codex generated last message for Memorize');
  });
});
