import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { POST_TOOL_USE_MATCHER } from '../../src/services/capture-service.js';

let sandbox: string;
let memorizeRoot: string;
let codexHome: string;

const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');
// Built CLI — the #122 node-abs hook embeds the path of the running module,
// so the #123 executability probe only resolves to a real file when install
// runs from dist/ (the production path). The dev/tsx entry would embed a
// `src/cli/index.js` path that never exists.
const distCliPath = join(repoRoot, 'dist', 'cli', 'index.js');

function runCli(args: string[], stdinPayload?: object) {
  return spawnSync('node', [tsxCliPath, cliEntryPath, ...args], {
    cwd: sandbox,
    encoding: 'utf8',
    env: {
      ...process.env,
      MEMORIZE_ROOT: memorizeRoot,
      // os.homedir() reads USERPROFILE on Windows, so override both.
      HOME: codexHome,
      USERPROFILE: codexHome,
      // Pin the hook command form: npm-linked test environments have
      // memorize on PATH so detectHookCommandForm() would return
      // 'bare', which mismatches the literal-string assertions below.
      // The bare path is exercised by its own dedicated test.
      MEMORIZE_HOOK_COMMAND_FORM: 'npx',
    },
    ...(stdinPayload ? { input: JSON.stringify(stdinPayload) } : {}),
  });
}

beforeAll(() => {
  // The #123 probe tests run install from the built dist/ CLI so the
  // node-abs hook embeds a path that actually exists. Build once if absent.
  if (!existsSync(distCliPath)) {
    const build = spawnSync('pnpm', ['build'], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: true,
    });
    if (build.status !== 0) {
      throw new Error(`dist build failed:\n${build.stdout}\n${build.stderr}`);
    }
  }
}, 120_000);

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
    expect(settings).toContain('PostCompact');
    // PreCompact left the contract in #85 (no-op handler; replaced by the
    // PostCompact consolidation boundary) — a fresh install must not write it.
    expect(settings).not.toContain('PreCompact');
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

  it('install codex preserves unrelated AGENTS.md content and appends the managed ground-rule block (#68)', async () => {
    const content = '# DuoPane\n\n- spec line 1\n- spec line 2\n';
    await writeFile(join(sandbox, 'AGENTS.md'), content, 'utf8');

    runCli(['install', 'codex']);

    const agents = await readFile(join(sandbox, 'AGENTS.md'), 'utf8');
    expect(agents.startsWith(content.trimEnd())).toBe(true);
    expect(agents).toContain('<!-- memorize:ground-rule v=1 start -->');
    expect(agents).toContain('single source of truth');
    expect(agents).toContain('<!-- memorize:ground-rule v=1 end -->');

    // Uninstall strips exactly the block; the user's content survives.
    runCli(['uninstall', 'codex']);
    const stripped = await readFile(join(sandbox, 'AGENTS.md'), 'utf8');
    expect(stripped).not.toContain('memorize:ground-rule');
    expect(stripped.trimEnd()).toBe(content.trimEnd());
  });

  it('install claude plants the ground-rule block in CLAUDE.md idempotently; uninstall strips it (#68)', async () => {
    // No CLAUDE.md yet — install creates it with just the block.
    const install = runCli(['install', 'claude']);
    expect(install.status).toBe(0);
    expect(install.stdout).toContain('ground-rule block to CLAUDE.md');
    const created = await readFile(join(sandbox, 'CLAUDE.md'), 'utf8');
    expect(created).toContain('<!-- memorize:ground-rule v=1 start -->');

    // Idempotent: re-install leaves exactly one block.
    runCli(['install', 'claude']);
    const again = await readFile(join(sandbox, 'CLAUDE.md'), 'utf8');
    expect(again.match(/memorize:ground-rule v=1 start/g)).toHaveLength(1);

    // User edits around the block survive uninstall; block does not.
    await writeFile(join(sandbox, 'CLAUDE.md'), `# My notes\n\n${again}`, 'utf8');
    runCli(['uninstall', 'claude']);
    const stripped = await readFile(join(sandbox, 'CLAUDE.md'), 'utf8');
    expect(stripped).toContain('# My notes');
    expect(stripped).not.toContain('memorize:ground-rule');
  });

  it('install claude plants the using-memorize skill idempotently; uninstall removes only its dir', async () => {
    const skillPath = join(
      sandbox,
      '.claude',
      'skills',
      'using-memorize',
      'SKILL.md',
    );
    // A sibling skill that must survive uninstall.
    const siblingDir = join(sandbox, '.claude', 'skills', 'other-skill');
    await mkdir(siblingDir, { recursive: true });
    await writeFile(join(siblingDir, 'SKILL.md'), '# other\n', 'utf8');

    // Install plants the skill file with the expected frontmatter.
    runCli(['install', 'claude']);
    const planted = await readFile(skillPath, 'utf8');
    expect(planted).toContain('name: using-memorize');

    // Idempotent: re-install does not throw and content is still present.
    const again = runCli(['install', 'claude']);
    expect(again.status).toBe(0);
    expect(await readFile(skillPath, 'utf8')).toContain('name: using-memorize');

    // Uninstall removes the using-memorize dir but leaves siblings.
    runCli(['uninstall', 'claude']);
    await expect(readFile(skillPath, 'utf8')).rejects.toThrow();
    expect(await readFile(join(siblingDir, 'SKILL.md'), 'utf8')).toContain(
      '# other',
    );

    // Uninstall again when absent does not throw.
    const secondUninstall = runCli(['uninstall', 'claude']);
    expect(secondUninstall.status).toBe(0);
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

  it('install codex warns that codex requires one-time hook trust approval', () => {
    // Verified live (codex v0.137.0, 2026-06-08): codex SILENTLY skips
    // externally-written hooks until the user approves them once. The
    // install output must surface this or the integration is a silent
    // no-op that looks installed.
    const result = runCli(['install', 'codex']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ACTION REQUIRED');
    expect(result.stdout).toContain('approve');
  });

  it('doctor detects a missing PostToolUse claude hook (#130 — installer wires 4 events, doctor must check all 4)', async () => {
    // Install (npx form) writes all four claude events. Doctor's event set
    // must match the installer's — including PostToolUse — or a missing
    // PostToolUse hook reads as a false green.
    runCli(['install', 'claude']);

    const settingsPath = join(sandbox, '.claude', 'settings.local.json');
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      hooks: Record<string, unknown[]>;
    };
    // Drop the PostToolUse memorize hook, leaving the other three intact.
    delete settings.hooks.PostToolUse;
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

    const result = runCli(['doctor', '--json']);
    const report = JSON.parse(String(result.stdout)) as {
      checks: Array<{ id: string; status: string; message: string }>;
    };
    const claudeCheck = report.checks.find((c) => c.id === 'install.claude');
    expect(claudeCheck?.status).toBe('warn');
    expect(claudeCheck?.message).toContain('PostToolUse');
  });

  it('doctor reports all 4 claude hooks present after a clean install (#130)', async () => {
    runCli(['install', 'claude']);

    const result = runCli(['doctor', '--json']);
    const report = JSON.parse(String(result.stdout)) as {
      checks: Array<{ id: string; status: string; message: string }>;
    };
    const claudeCheck = report.checks.find((c) => c.id === 'install.claude');
    // npx form is presence-only (no offline probe); all 4 present → ok.
    expect(claudeCheck === undefined || claudeCheck.status === 'ok').toBe(true);
    if (claudeCheck) {
      expect(claudeCheck.message).toContain('4 memorize hooks');
    }
  });

  it('doctor reports install.claude:ok for a freshly, correctly installed node-abs hook (#123)', async () => {
    // bare form emits the node-abs invocation pointing at the real
    // dist/cli/index.js — the probe runs `node "<abs>" --version` and must
    // succeed, keeping status ok. Runs from dist so the embedded path exists.
    const install = spawnSync('node', [distCliPath, 'install', 'claude'], {
      cwd: sandbox,
      encoding: 'utf8',
      env: {
        ...process.env,
        MEMORIZE_ROOT: memorizeRoot,
        HOME: codexHome,
        USERPROFILE: codexHome,
        MEMORIZE_HOOK_COMMAND_FORM: 'bare',
      },
    });
    expect(install.status).toBe(0);

    const result = spawnSync('node', [distCliPath, 'doctor', '--json'], {
      cwd: sandbox,
      encoding: 'utf8',
      env: {
        ...process.env,
        MEMORIZE_ROOT: memorizeRoot,
        HOME: codexHome,
        USERPROFILE: codexHome,
        MEMORIZE_HOOK_COMMAND_FORM: 'bare',
      },
    });
    const report = JSON.parse(String(result.stdout)) as {
      checks: Array<{ id: string; status: string; message: string }>;
    };
    const claudeCheck = report.checks.find((c) => c.id === 'install.claude');
    // Present and runnable → ok (or omitted, which doctor treats as a no-op
    // green when zero memorize hooks — but here all four are present).
    expect(claudeCheck === undefined || claudeCheck.status === 'ok').toBe(true);
  });

  it('doctor does NOT report install.claude:ok when a node-abs hook points at an unresolvable path (#123 — presence-only would false-green)', async () => {
    // Install the node-abs (bare) form, then rewrite the cli.js path to a
    // path that does not exist. Presence regex still matches, but the
    // command can never run — doctor must downgrade off ok.
    spawnSync('node', [distCliPath, 'install', 'claude'], {
      cwd: sandbox,
      encoding: 'utf8',
      env: {
        ...process.env,
        MEMORIZE_ROOT: memorizeRoot,
        HOME: codexHome,
        USERPROFILE: codexHome,
        MEMORIZE_HOOK_COMMAND_FORM: 'bare',
      },
    });

    const settingsPath = join(sandbox, '.claude', 'settings.local.json');
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      hooks: Record<
        string,
        Array<{ hooks: Array<{ command: string }> }>
      >;
    };
    // Point every node-abs command at a cli/index.js that does not exist,
    // keeping the memorize-identifying path shape so presence still matches.
    for (const groups of Object.values(settings.hooks)) {
      for (const group of groups) {
        for (const entry of group.hooks ?? []) {
          entry.command = entry.command.replace(
            /node "[^"]*\/cli\/index\.js"/,
            'node "C:/nonexistent-memorize/dist/cli/index.js"',
          );
        }
      }
    }
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');

    const result = spawnSync('node', [tsxCliPath, cliEntryPath, 'doctor', '--json'], {
      cwd: sandbox,
      encoding: 'utf8',
      env: {
        ...process.env,
        MEMORIZE_ROOT: memorizeRoot,
        HOME: codexHome,
        USERPROFILE: codexHome,
        MEMORIZE_HOOK_COMMAND_FORM: 'bare',
      },
    });
    const report = JSON.parse(String(result.stdout)) as {
      checks: Array<{ id: string; status: string; message: string }>;
    };
    const claudeCheck = report.checks.find((c) => c.id === 'install.claude');
    expect(claudeCheck).toBeDefined();
    expect(claudeCheck?.status).not.toBe('ok');
    expect(claudeCheck?.message).toContain('nonexistent-memorize');
  });

  it('doctor reports install.codex:ok after a clean install codex', () => {
    runCli(['install', 'codex']);

    const result = runCli(['doctor', '--json']);
    const report = JSON.parse(String(result.stdout)) as {
      checks: Array<{ id: string; status: string; message: string }>;
    };
    const codexCheck = report.checks.find((c) => c.id === 'install.codex');
    expect(codexCheck?.status).toBe('ok');
    // The ok message carries the trust caveat — registration is the most
    // doctor can verify (codex keeps hook trust state internal).
    expect(codexCheck?.message).toContain('PostToolUse');
    expect(codexCheck?.message).toContain('approve');
  });

  it('doctor warns on the codex trust gap: hooks registered, other-agent sessions exist, zero codex sessions (#37)', () => {
    runCli(['install', 'codex']);

    // A claude session gets recorded; codex never records one. If the codex
    // hooks had ever fired (i.e. were approved), a codex session.started
    // would exist too — so their absence implies the trust gap.
    const start = runCli(['hook', 'claude', 'SessionStart'], {
      cwd: sandbox,
      hook_event_name: 'SessionStart',
      session_id: 'trust-gap-uuid-1',
    });
    expect(start.status).toBe(0);

    const result = runCli(['doctor', '--json']);
    const report = JSON.parse(String(result.stdout)) as {
      checks: Array<{ id: string; status: string; message: string; fix?: string }>;
    };
    const codexCheck = report.checks.find((c) => c.id === 'install.codex');
    expect(codexCheck?.status).toBe('warn');
    expect(codexCheck?.message).toContain('no codex session');
    expect(codexCheck?.fix).toContain('approve');
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

  it('install claude with MEMORIZE_HOOK_COMMAND_FORM=bare emits an absolute node invocation (#122 — bare `memorize` is not on Git Bash PATH when Claude runs hooks)', async () => {
    // Why we care: Claude Code executes hooks via Git Bash, where the npm
    // global bin is NOT on PATH — a literal `memorize` token there fails
    // `command not found`. The fast (`bare`) form therefore emits
    // `node "<abs .../dist/cli/index.js>" hook ...`: `node` is always
    // resolvable, the absolute path removes shim/PATHEXT/PATH ambiguity,
    // and a direct node launch keeps the ms-level startup the bare form
    // was chosen for (so SessionEnd cleanup still completes before Claude
    // reaps the subprocess). It must NOT regress to npx.
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
          USERPROFILE: codexHome,
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

    for (const event of ['SessionStart', 'PostCompact', 'SessionEnd']) {
      const groups = settings.hooks[event] ?? [];
      const cmds = groups.flatMap((g) => g.hooks.map((h) => h.command));
      const memorizeCmd = cmds.find((c) => /\bhook\s+claude/.test(c));
      expect(memorizeCmd, `event ${event} has a memorize entry`).toBeDefined();
      // node-abs form: `node "<abs>/cli/index.js" hook claude <event>`.
      expect(memorizeCmd!).toMatch(/^node\s+"/);
      expect(memorizeCmd!).toMatch(/\/cli\/index\.js"\s/);
      expect(memorizeCmd!).toMatch(new RegExp(`hook claude ${event}$`));
      expect(memorizeCmd!).not.toMatch(/^npx\s/);
    }
  });

  it('registers the CLS capture + boundary hooks (spec §8 — automated in place of manual dogfood)', async () => {
    // Claude: PostToolUse must be registered WITH the tool matcher derived
    // from capture-service's whitelist (single source — a drift between
    // matcher and filter is a silent capture outage).
    const claude = runCli(['install', 'claude']);
    expect(claude.status).toBe(0);

    const settings = JSON.parse(
      await readFile(join(sandbox, '.claude', 'settings.local.json'), 'utf8'),
    ) as {
      hooks: Record<
        string,
        Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>
      >;
    };
    const postToolUse = (settings.hooks.PostToolUse ?? []).find((group) =>
      group.hooks.some((entry) => /memorize hook claude PostToolUse/.test(entry.command)),
    );
    expect(postToolUse).toBeDefined();
    // Asserted against the single-source constant so matcher/filter can never
    // drift. apply_patch is included for codex file-edit capture symmetry.
    expect(postToolUse?.matcher).toBe(POST_TOOL_USE_MATCHER);
    expect(postToolUse?.matcher).toContain('apply_patch');

    // Re-install must not duplicate the matcher'd entry.
    runCli(['install', 'claude']);
    const settingsAfter = JSON.parse(
      await readFile(join(sandbox, '.claude', 'settings.local.json'), 'utf8'),
    ) as typeof settings;
    const postToolUseEntries = (settingsAfter.hooks.PostToolUse ?? []).flatMap((g) =>
      g.hooks.filter((h) => /memorize hook claude PostToolUse/.test(h.command)),
    );
    expect(postToolUseEntries).toHaveLength(1);

    // Codex: capture (PostToolUse) + compaction boundary (PostCompact) are
    // registered globally — codex has no SessionEnd, so PostCompact + the
    // next SessionStart's catch-up are its only consolidation boundaries.
    const codex = runCli(['install', 'codex']);
    expect(codex.status).toBe(0);
    const codexHooks = JSON.parse(
      await readFile(join(codexHome, '.codex', 'hooks.json'), 'utf8'),
    ) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    for (const event of ['SessionStart', 'PostToolUse', 'PostCompact']) {
      const cmds = (codexHooks.hooks[event] ?? []).flatMap((g) =>
        g.hooks.map((h) => h.command),
      );
      expect(
        cmds.some((c) => new RegExp(`memorize hook codex ${event}`).test(c)),
        `codex ${event} registered`,
      ).toBe(true);
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
             USERPROFILE: codexHome, MEMORIZE_HOOK_COMMAND_FORM: 'npx' },
    });
    spawnSync('node', [tsxCliPath, cliEntryPath, 'install', 'claude'], {
      cwd: sandbox,
      encoding: 'utf8',
      env: { ...process.env, MEMORIZE_ROOT: memorizeRoot, HOME: codexHome,
             USERPROFILE: codexHome, MEMORIZE_HOOK_COMMAND_FORM: 'bare' },
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
      // Match any memorize form (npx token OR node-abs cli/index.js) so the
      // strip's form-migration is what's under test, not the literal shape.
      const memorizeCmds = cmds.filter(
        (c) => /memorize\s+hook\s+claude/.test(c) || /\/cli\/index\.js"\s+hook\s+claude/.test(c),
      );
      expect(memorizeCmds.length, `event ${event} should have exactly one memorize entry`).toBe(1);
      // After swapping npx → bare, the surviving entry is the node-abs form.
      expect(memorizeCmds[0]).toMatch(/^node\s+".*\/cli\/index\.js"\s+hook claude /);
      expect(memorizeCmds[0]).toMatch(new RegExp(`hook claude ${event}$`));
    }
  });
});
