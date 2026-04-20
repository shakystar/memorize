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

  it('preserves existing third-party hooks and places memorize first', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const hooksPath = join(codexHome, '.codex', 'hooks.json');
    await mkdir(join(codexHome, '.codex'), { recursive: true });
    await writeFile(
      hooksPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                matcher: 'startup|resume',
                hooks: [{ type: 'command', command: 'node /path/to/omx.js' }],
              },
            ],
            Stop: [
              {
                hooks: [{ type: 'command', command: 'node /path/to/omx.js' }],
              },
            ],
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const result = runCli(['install', 'codex']);
    expect(result.status).toBe(0);

    const hooks = JSON.parse(await readFile(hooksPath, 'utf8')) as {
      hooks: Record<
        string,
        Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>
      >;
    };

    const sessionStart = hooks.hooks.SessionStart!;
    // Memorize first, OMX second.
    expect(sessionStart[0]?.hooks[0]?.command).toContain(
      'memorize hook codex SessionStart',
    );
    expect(sessionStart[1]?.hooks[0]?.command).toContain('omx.js');

    const stop = hooks.hooks.Stop!;
    expect(stop[0]?.hooks[0]?.command).toContain('memorize hook codex Stop');
    expect(stop[1]?.hooks[0]?.command).toContain('omx.js');
  });

  it('is idempotent — a second install does not duplicate memorize entries', async () => {
    const first = runCli(['install', 'codex']);
    expect(first.status).toBe(0);
    const second = runCli(['install', 'codex']);
    expect(second.status).toBe(0);

    const hooks = JSON.parse(
      await readFile(join(codexHome, '.codex', 'hooks.json'), 'utf8'),
    ) as {
      hooks: Record<
        string,
        Array<{ hooks: Array<{ command: string }> }>
      >;
    };

    const memorizeCount = (hooks.hooks.SessionStart ?? []).filter((group) =>
      group.hooks.some((h) => h.command.includes('memorize hook codex')),
    ).length;
    expect(memorizeCount).toBe(1);
  });

  it('migrates legacy {command}-only entries to the matcher+hooks shape', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const hooksPath = join(codexHome, '.codex', 'hooks.json');
    await mkdir(join(codexHome, '.codex'), { recursive: true });
    await writeFile(
      hooksPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [{ command: 'node /path/to/legacy.js' }],
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    runCli(['install', 'codex']);

    const hooks = JSON.parse(await readFile(hooksPath, 'utf8')) as {
      hooks: Record<
        string,
        Array<{
          matcher?: string;
          hooks?: Array<{ type: string; command: string }>;
          command?: string;
        }>
      >;
    };

    const anyLegacy = Object.values(hooks.hooks).some((list) =>
      list.some(
        (entry) =>
          !Array.isArray(entry.hooks) && typeof entry.command === 'string',
      ),
    );
    expect(anyLegacy).toBe(false);
  });
});
