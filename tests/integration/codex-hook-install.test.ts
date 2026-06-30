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
      // os.homedir() reads USERPROFILE on Windows, so override both.
      HOME: codexHome,
      USERPROFILE: codexHome,
      // Pin the hook command form for predictable assertions; bare
      // form is covered by a dedicated test below.
      MEMORIZE_HOOK_COMMAND_FORM: 'npx',
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
  it('creates ~/.codex/hooks.json with only the memorize SessionStart entry (β redesign drops Stop)', async () => {
    // β redesign: codex has no SessionEnd / Shutdown hook (verified
    // against developers.openai.com/codex/hooks). Stop fires per-turn,
    // so wiring it caused the same bogus per-turn artifacts as Claude.
    // Codex lifecycle is owned entirely by reapStaleSessions; the only
    // hook we register is SessionStart (which itself triggers the reap
    // sweep on entry).
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

    // Memorize must NOT appear under Stop after a clean install. A
    // pre-β install would have planted us there; install must also
    // strip it out on re-run.
    const stop = hooks.hooks.Stop ?? [];
    expect(
      stop.some((group) =>
        group.hooks.some((h) =>
          h.command.includes('memorize hook codex Stop'),
        ),
      ),
    ).toBe(false);
  });

  it('preserves existing third-party Stop entries while removing legacy memorize Stop', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const hooksPath = join(codexHome, '.codex', 'hooks.json');
    await mkdir(join(codexHome, '.codex'), { recursive: true });
    // Simulate a pre-β install: memorize Stop alongside an unrelated
    // OMX Stop. After install, OMX stays, memorize is gone.
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
                hooks: [
                  { type: 'command', command: 'npx @shakystar/memorize hook codex Stop' },
                  { type: 'command', command: 'node /path/to/omx.js' },
                ],
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

    // Stop entries: memorize stripped, OMX preserved.
    const stop = hooks.hooks.Stop ?? [];
    const stopCommands = stop.flatMap((g) => g.hooks.map((h) => h.command));
    expect(stopCommands.some((cmd) => cmd.includes('memorize hook codex Stop'))).toBe(
      false,
    );
    expect(stopCommands.some((cmd) => cmd.includes('omx.js'))).toBe(true);
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

  it('strips the legacy resolved-binary (.cmd shim) form on re-install instead of duplicating', async () => {
    // Pre-#122 Windows installs wrote `which.sync('memorize')` verbatim — the
    // `.cmd` shim path. The old token required whitespace right after
    // `memorize`, so the `.cmd` between name and `hook` made it un-strippable,
    // and every re-install ADDED a new entry alongside it. Seed that exact shape
    // and assert a fresh install collapses to a single memorize entry.
    const { mkdir, writeFile } = await import('node:fs/promises');
    const hooksPath = join(codexHome, '.codex', 'hooks.json');
    await mkdir(join(codexHome, '.codex'), { recursive: true });
    const legacyCmd =
      'C:/Users/me/AppData/Roaming/npm/memorize.cmd hook codex SessionStart';
    await writeFile(
      hooksPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                matcher: 'startup|resume',
                hooks: [{ type: 'command', command: legacyCmd }],
              },
            ],
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    expect(runCli(['install', 'codex']).status).toBe(0);

    const raw = await readFile(hooksPath, 'utf8');
    // The legacy .cmd entry must be gone (stripped, not left orphaned).
    expect(raw).not.toContain('memorize.cmd');
    const hooks = JSON.parse(raw) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const memorizeCount = (hooks.hooks.SessionStart ?? []).filter((group) =>
      group.hooks.some((h) => /memorize hook codex|memorize\b.*hook codex/.test(h.command)),
    ).length;
    expect(memorizeCount).toBe(1);
  });
});
