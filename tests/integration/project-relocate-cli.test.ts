import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

let sandbox: string;
let memorizeRoot: string;
let pathA: string;
let pathB: string;

beforeEach(async () => {
  // Canonicalize: os.tmpdir() is a symlink on macOS (/var -> /private/var) and
  // short-named on Windows, so the raw mkdtemp path differs from the realpath a
  // spawned process sees for process.cwd(). `project relocate` keys the binding
  // off the path argument while `project show` resolves cwd — without this the
  // two diverge and show can't find the relocated project.
  sandbox = await realpath(await mkdtemp(join(tmpdir(), 'memorize-relocate-cli-')));
  memorizeRoot = join(sandbox, '.memorize-home');
  pathA = join(sandbox, 'old', 'emis');
  pathB = join(sandbox, 'new', 'emis');
  await mkdir(pathA, { recursive: true });
  await mkdir(pathB, { recursive: true });
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

function runMemorize(
  args: string[],
  cwd: string,
): SpawnSyncReturns<string> {
  return spawnSync('node', [tsxCliPath, cliEntryPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, MEMORIZE_ROOT: memorizeRoot },
  });
}

describe('memorize project relocate (CLI)', () => {
  it('rebinds an adopted project from path A to path B (same id)', () => {
    const init = runMemorize(['project', 'init'], pathA);
    expect(init.status).toBe(0);
    const id = init.stdout.match(/proj_[A-Za-z0-9_]+/)?.[0];
    expect(id).toBeDefined();

    const relocate = runMemorize(
      ['project', 'relocate', pathB, '--project', id as string],
      pathA,
    );
    expect(relocate.status).toBe(0);
    expect(relocate.stdout).toContain('Relocated project');
    expect(relocate.stdout).toContain(id as string);

    // `project show` from path B now resolves to the SAME project id.
    const show = runMemorize(['project', 'show'], pathB);
    expect(show.status).toBe(0);
    expect(show.stdout).toContain(`"id": "${id}"`);
  });

  it('errors without --project or --from', () => {
    const result = runMemorize(['project', 'relocate', pathB], pathB);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--project|--from/);
  });
});
