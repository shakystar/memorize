import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let sandbox: string;
let codexHome: string;
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
      // Override HOME so tests write to a sandboxed ~/.codex, not the real one.
      HOME: codexHome,
    },
  });
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-codex-install-'));
  codexHome = join(sandbox, 'fake-home');
  memorizeRoot = join(sandbox, '.memorize-home');
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('install codex hooks', () => {
  it('creates ~/.codex/hooks.json with memorize SessionStart + Stop entries', async () => {
    const result = runCli(['install', 'codex']);
    expect(result.status).toBe(0);

    const hooks = JSON.parse(
      await readFile(join(codexHome, '.codex', 'hooks.json'), 'utf8'),
    ) as {
      hooks: Record<
        string,
        Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>
      >;
    };

    const sessionStart = hooks.hooks.SessionStart ?? [];
    expect(
      sessionStart.some((group) =>
        group.hooks.some((h) =>
          h.command.includes('@shakystar/memorize hook codex SessionStart'),
        ),
      ),
    ).toBe(true);

    const stop = hooks.hooks.Stop ?? [];
    expect(
      stop.some((group) =>
        group.hooks.some((h) =>
          h.command.includes('@shakystar/memorize hook codex Stop'),
        ),
      ),
    ).toBe(true);
  });
});
