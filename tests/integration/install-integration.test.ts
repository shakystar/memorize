import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let sandbox: string;
let memorizeRoot: string;
let codexHome: string;

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
      HOME: codexHome,
    },
  });
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-install-'));
  memorizeRoot = join(sandbox, '.memorize-home');
  codexHome = join(sandbox, 'fake-home');
  await mkdir(join(sandbox, '.cursor', 'rules'), { recursive: true });
  await writeFile(join(sandbox, 'AGENTS.md'), '# Guidance\nUse small commits.\n', 'utf8');
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('install integration', () => {
  it('installs Claude hook configuration into the project', async () => {
    const result = runCli(['install', 'claude']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Installed Claude integration');

    const settings = await readFile(
      join(sandbox, '.claude', 'settings.local.json'),
      'utf8',
    );
    expect(settings).toContain('SessionStart');
    expect(settings).toContain('PreCompact');
    expect(settings).toContain('PostCompact');
    expect(settings).toContain('npx @shakystar/memorize hook claude SessionStart');
  });

  it('produces the Claude Code-compatible hook schema with matcher + hooks array', async () => {
    runCli(['install', 'claude']);

    const settings = JSON.parse(
      await readFile(join(sandbox, '.claude', 'settings.local.json'), 'utf8'),
    ) as {
      hooks: Record<
        string,
        Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>
      >;
    };

    const sessionStart = settings.hooks.SessionStart?.[0];
    expect(sessionStart).toBeDefined();
    expect(typeof sessionStart?.matcher).toBe('string');
    expect(Array.isArray(sessionStart?.hooks)).toBe(true);
    expect(sessionStart?.hooks[0]?.type).toBe('command');
    expect(sessionStart?.hooks[0]?.command).toBe(
      'npx @shakystar/memorize hook claude SessionStart',
    );
  });

  it('merges Claude settings without deleting existing hooks and is idempotent', async () => {
    await mkdir(join(sandbox, '.claude'), { recursive: true });
    await writeFile(
      join(sandbox, '.claude', 'settings.local.json'),
      JSON.stringify(
        {
          hooks: {
            Other: [
              {
                matcher: '',
                hooks: [{ type: 'command', command: 'keep-me' }],
              },
            ],
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const first = runCli(['install', 'claude']);
    const second = runCli(['install', 'claude']);

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);

    const settings = JSON.parse(
      await readFile(join(sandbox, '.claude', 'settings.local.json'), 'utf8'),
    ) as {
      hooks: Record<
        string,
        Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>
      >;
    };

    expect(settings.hooks.Other?.[0]?.hooks[0]?.command).toBe('keep-me');
    expect(
      settings.hooks.SessionStart?.filter((group) =>
        group.hooks.some(
          (entry) =>
            entry.command === 'npx @shakystar/memorize hook claude SessionStart',
        ),
      ).length,
    ).toBe(1);
  });

  it('migrates legacy {command} entries to the matcher + hooks array shape', async () => {
    await mkdir(join(sandbox, '.claude'), { recursive: true });
    await writeFile(
      join(sandbox, '.claude', 'settings.local.json'),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              { command: 'memorize hook claude SessionStart' },
            ],
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const result = runCli(['install', 'claude']);
    expect(result.status).toBe(0);

    const settings = JSON.parse(
      await readFile(join(sandbox, '.claude', 'settings.local.json'), 'utf8'),
    ) as {
      hooks: Record<
        string,
        Array<{ matcher?: string; hooks?: Array<{ type: string; command: string }> }>
      >;
    };

    // No raw `{command}` survives.
    const anyLegacy = Object.values(settings.hooks).some((list) =>
      list.some(
        (entry) =>
          !Array.isArray(entry.hooks) && typeof (entry as { command?: string }).command === 'string',
      ),
    );
    expect(anyLegacy).toBe(false);

    // The new scoped command is present.
    expect(
      settings.hooks.SessionStart?.some((group) =>
        group.hooks?.some(
          (entry) =>
            entry.command === 'npx @shakystar/memorize hook claude SessionStart',
        ),
      ),
    ).toBe(true);
  });

  it('install codex does not create AGENTS.override.md on a clean project', async () => {
    const result = runCli(['install', 'codex']);
    expect(result.status).toBe(0);
    await expect(
      readFile(join(sandbox, 'AGENTS.override.md'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('install codex strips a pre-existing memorize v=1 block from AGENTS.override.md', async () => {
    await writeFile(
      join(sandbox, 'AGENTS.override.md'),
      [
        '# Team notes',
        '',
        'Keep this.',
        '',
        '<!-- memorize:bootstrap v=1 start -->',
        '- Old body',
        '<!-- memorize:bootstrap v=1 end -->',
        '',
        '# More team notes',
      ].join('\n'),
      'utf8',
    );

    runCli(['install', 'codex']);

    const override = await readFile(
      join(sandbox, 'AGENTS.override.md'),
      'utf8',
    );
    expect(override).toContain('Keep this.');
    expect(override).toContain('# More team notes');
    expect(override).not.toContain('memorize:bootstrap');
    expect(override).not.toContain('Old body');
  });

  it('install codex strips the pre-v=1 legacy memorize block as well', async () => {
    await writeFile(
      join(sandbox, 'AGENTS.override.md'),
      [
        '<!-- Memorize:START -->',
        '- Ancient body',
        '<!-- Memorize:END -->',
      ].join('\n'),
      'utf8',
    );

    runCli(['install', 'codex']);

    // After stripping everything, the file should be gone.
    await expect(
      readFile(join(sandbox, 'AGENTS.override.md'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('install codex keeps unrelated AGENTS.override.md content untouched when no memorize block exists', async () => {
    const content = '# Team overrides\n\n- rule 1\n- rule 2\n';
    await writeFile(join(sandbox, 'AGENTS.override.md'), content, 'utf8');

    runCli(['install', 'codex']);

    const override = await readFile(
      join(sandbox, 'AGENTS.override.md'),
      'utf8',
    );
    expect(override).toBe(content);
  });
});
