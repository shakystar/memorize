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
      // Pin the hook command form: npm-linked test environments have
      // memorize on PATH so detectHookCommandForm() would return
      // 'bare', which mismatches the literal-string assertions below.
      // The bare path is exercised by its own dedicated test.
      MEMORIZE_HOOK_COMMAND_FORM: 'npx',
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

  it('install codex strips a pre-existing memorize v=1 block from AGENTS.md while preserving user content', async () => {
    await writeFile(
      join(sandbox, 'AGENTS.md'),
      [
        '# DuoPane',
        '',
        'Project description that the user authored.',
        '',
        '<!-- memorize:bootstrap v=1 start -->',
        '- Stale bootstrap body',
        '<!-- memorize:bootstrap v=1 end -->',
        '',
        '## Goals',
        '- Ship fast',
      ].join('\n'),
      'utf8',
    );

    runCli(['install', 'codex']);

    const agents = await readFile(join(sandbox, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('# DuoPane');
    expect(agents).toContain('Project description that the user authored.');
    expect(agents).toContain('## Goals');
    expect(agents).not.toContain('memorize:bootstrap');
    expect(agents).not.toContain('Stale bootstrap body');
  });

  it('install codex never deletes AGENTS.md even if the strip leaves it empty', async () => {
    // AGENTS.md is user-owned. Even if the only content was the legacy
    // memorize block, the file itself must survive — that deletion is
    // the user's call to make, not ours.
    await writeFile(
      join(sandbox, 'AGENTS.md'),
      [
        '<!-- memorize:bootstrap v=1 start -->',
        '- Old body',
        '<!-- memorize:bootstrap v=1 end -->',
      ].join('\n'),
      'utf8',
    );

    runCli(['install', 'codex']);

    const agents = await readFile(join(sandbox, 'AGENTS.md'), 'utf8');
    expect(agents).not.toContain('memorize:bootstrap');
    expect(agents).not.toContain('Old body');
  });

  it('install codex keeps unrelated AGENTS.md content untouched when no memorize block exists', async () => {
    const content = '# DuoPane\n\n- spec line 1\n- spec line 2\n';
    await writeFile(join(sandbox, 'AGENTS.md'), content, 'utf8');

    runCli(['install', 'codex']);

    const agents = await readFile(join(sandbox, 'AGENTS.md'), 'utf8');
    expect(agents).toBe(content);
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

  it('doctor reports install.codex:ok after a clean install codex', () => {
    runCli(['install', 'codex']);

    const result = runCli(['doctor', '--json']);
    const report = JSON.parse(String(result.stdout)) as {
      checks: Array<{ id: string; status: string }>;
    };
    const codexCheck = report.checks.find((c) => c.id === 'install.codex');
    expect(codexCheck?.status).toBe('ok');
  });

  it('doctor reports install.codex:warn when hooks.json exists but memorize hooks are missing', async () => {
    runCli(['install', 'codex']);

    const hooksPath = join(codexHome, '.codex', 'hooks.json');
    const raw = JSON.parse(await readFile(hooksPath, 'utf8')) as {
      hooks: Record<string, unknown[]>;
    };
    raw.hooks.SessionStart = [];
    raw.hooks.Stop = [];
    await writeFile(hooksPath, JSON.stringify(raw, null, 2), 'utf8');

    const result = runCli(['doctor', '--json']);
    const report = JSON.parse(String(result.stdout)) as {
      checks: Array<{ id: string; status: string; message: string }>;
    };
    const codexCheck = report.checks.find((c) => c.id === 'install.codex');
    expect(codexCheck?.status).toBe('warn');
    expect(codexCheck?.message).toMatch(/memorize hooks/);
  });

  it('doctor omits install.codex when no ~/.codex/hooks.json exists at all', () => {
    // Fresh project, no install codex run.
    runCli(['install', 'claude']);  // bind project; doctor needs a bound project to run most checks.
    // But note: the key fact is no install codex was run. codexHome exists (mkdtemp made it)
    // but ~/.codex/hooks.json doesn't.
    const result = runCli(['doctor', '--json']);
    const report = JSON.parse(String(result.stdout)) as {
      checks: Array<{ id: string }>;
    };
    expect(report.checks.find((c) => c.id === 'install.codex')).toBeUndefined();
  });

  it('install claude with MEMORIZE_HOOK_COMMAND_FORM=bare uses bare `memorize` (faster, lets SessionEnd finish before Claude exits)', async () => {
    // Why we care: Claude's SessionEnd hook is non-blocking — Claude
    // reaps the subprocess as soon as it exits, so npx's cold-cache
    // resolution latency was preventing cleanup work from completing
    // (verified empirically during rc.5 dogfood). Using bare
    // `memorize` when it's on PATH avoids npx entirely and gets the
    // cleanup done in milliseconds.
    const result = spawnSync(
      'node',
      [tsxCliPath, cliEntryPath, 'install', 'claude'],
      {
        cwd: sandbox,
        encoding: 'utf8',
        env: {
          ...process.env,
          MEMORIZE_ROOT: memorizeRoot,
          HOME: codexHome,
          MEMORIZE_HOOK_COMMAND_FORM: 'bare',
        },
      },
    );
    expect(result.status).toBe(0);

    const settings = JSON.parse(
      await readFile(join(sandbox, '.claude', 'settings.local.json'), 'utf8'),
    ) as {
      hooks: Record<
        string,
        Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>
      >;
    };

    for (const event of ['SessionStart', 'PreCompact', 'PostCompact', 'SessionEnd']) {
      const groups = settings.hooks[event] ?? [];
      const cmds = groups.flatMap((g) => g.hooks.map((h) => h.command));
      const memorizeCmd = cmds.find((c) => /memorize\s+hook\s+claude/.test(c));
      expect(memorizeCmd, `event ${event} has a memorize entry`).toBeDefined();
      expect(memorizeCmd!).toBe(`memorize hook claude ${event}`);
      expect(memorizeCmd!).not.toMatch(/^npx\s/);
    }
  });

  it('re-installing with a different command form swaps it cleanly (no orphan duplicate entries)', async () => {
    // Sequence: install once with npx → install again with bare. The
    // file must end with exactly one memorize entry per event, in
    // bare form. Catches a regression where strip-by-exact-string
    // would leave the npx entry behind when bare was added.
    spawnSync('node', [tsxCliPath, cliEntryPath, 'install', 'claude'], {
      cwd: sandbox,
      encoding: 'utf8',
      env: { ...process.env, MEMORIZE_ROOT: memorizeRoot, HOME: codexHome,
             MEMORIZE_HOOK_COMMAND_FORM: 'npx' },
    });
    spawnSync('node', [tsxCliPath, cliEntryPath, 'install', 'claude'], {
      cwd: sandbox,
      encoding: 'utf8',
      env: { ...process.env, MEMORIZE_ROOT: memorizeRoot, HOME: codexHome,
             MEMORIZE_HOOK_COMMAND_FORM: 'bare' },
    });

    const settings = JSON.parse(
      await readFile(join(sandbox, '.claude', 'settings.local.json'), 'utf8'),
    ) as {
      hooks: Record<
        string,
        Array<{ hooks: Array<{ command: string }> }>
      >;
    };

    for (const event of ['SessionStart', 'SessionEnd']) {
      const cmds = (settings.hooks[event] ?? []).flatMap((g) =>
        g.hooks.map((h) => h.command),
      );
      const memorizeCmds = cmds.filter((c) => /memorize\s+hook\s+claude/.test(c));
      expect(memorizeCmds.length, `event ${event} should have exactly one memorize entry`).toBe(1);
      expect(memorizeCmds[0]).toBe(`memorize hook claude ${event}`);
    }
  });
});
