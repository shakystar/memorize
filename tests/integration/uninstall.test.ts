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
      USERPROFILE: codexHome,
      MEMORIZE_HOOK_COMMAND_FORM: 'npx',
    },
  });
}

function readJson(path: string): Promise<{ hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>> }> {
  return readFile(path, 'utf8').then(
    (raw) => JSON.parse(raw) as { hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>> },
  );
}

function memorizeCommandCount(
  hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> | undefined,
): number {
  if (!hooks) return 0;
  return Object.values(hooks)
    .flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)))
    .filter((c) => /memorize\s+hook/.test(c)).length;
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-uninstall-'));
  memorizeRoot = join(sandbox, '.memorize-home');
  codexHome = join(sandbox, 'fake-home');
  await writeFile(join(sandbox, 'AGENTS.md'), '# Guidance\nUse small commits.\n', 'utf8');
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('uninstall', () => {
  it('removes Claude memorize hooks while preserving the user\'s other hooks', async () => {
    await mkdir(join(sandbox, '.claude'), { recursive: true });
    const settingsPath = join(sandbox, '.claude', 'settings.local.json');
    await writeFile(
      settingsPath,
      JSON.stringify(
        { hooks: { Other: [{ matcher: '', hooks: [{ type: 'command', command: 'keep-me' }] }] } },
        null,
        2,
      ),
      'utf8',
    );

    expect(runCli(['install', 'claude']).status).toBe(0);
    expect(memorizeCommandCount((await readJson(settingsPath)).hooks)).toBeGreaterThan(0);

    const result = runCli(['uninstall', 'claude']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Removed Claude integration');

    const after = await readJson(settingsPath);
    expect(memorizeCommandCount(after.hooks)).toBe(0); // all memorize hooks gone
    // The user's unrelated hook survives.
    const otherCmds = (after.hooks?.Other ?? []).flatMap((g) => g.hooks.map((h) => h.command));
    expect(otherCmds).toContain('keep-me');
  });

  it('removes Codex memorize hooks while preserving the user\'s other hooks', async () => {
    await mkdir(join(codexHome, '.codex'), { recursive: true });
    const hooksPath = join(codexHome, '.codex', 'hooks.json');
    await writeFile(
      hooksPath,
      JSON.stringify(
        { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'other-tool-hook' }] }] } },
        null,
        2,
      ),
      'utf8',
    );

    expect(runCli(['install', 'codex']).status).toBe(0);
    expect(memorizeCommandCount((await readJson(hooksPath)).hooks)).toBeGreaterThan(0);

    const result = runCli(['uninstall', 'codex']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Removed Codex integration');

    const after = await readJson(hooksPath);
    expect(memorizeCommandCount(after.hooks)).toBe(0);
    const startCmds = (after.hooks?.SessionStart ?? []).flatMap((g) => g.hooks.map((h) => h.command));
    expect(startCmds).toContain('other-tool-hook');
  });

  it('strips a memorize block from AGENTS.md on codex uninstall, preserving user content', async () => {
    await writeFile(
      join(sandbox, 'AGENTS.md'),
      [
        '# Project',
        '',
        'User authored.',
        '',
        '<!-- memorize:bootstrap v=1 start -->',
        '- bootstrap body',
        '<!-- memorize:bootstrap v=1 end -->',
        '',
        '## Goals',
      ].join('\n'),
      'utf8',
    );

    expect(runCli(['uninstall', 'codex']).status).toBe(0);
    const agents = await readFile(join(sandbox, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('User authored.');
    expect(agents).toContain('## Goals');
    expect(agents).not.toContain('memorize:bootstrap');
  });

  it('is a no-op on a clean project (nothing installed)', () => {
    const result = runCli(['uninstall', 'claude']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Removed Claude integration');
  });

  it('with no target removes both claude and codex', async () => {
    expect(runCli(['install', 'claude']).status).toBe(0);
    expect(runCli(['install', 'codex']).status).toBe(0);

    const result = runCli(['uninstall']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Removed Claude integration');
    expect(result.stdout).toContain('Removed Codex integration');

    expect(
      memorizeCommandCount((await readJson(join(sandbox, '.claude', 'settings.local.json'))).hooks),
    ).toBe(0);
    expect(
      memorizeCommandCount((await readJson(join(codexHome, '.codex', 'hooks.json'))).hooks),
    ).toBe(0);
  });

  it('rejects an unknown target', () => {
    const result = runCli(['uninstall', 'vscode']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Uninstall target');
  });

  it('install then uninstall round-trips Claude settings back to memorize-free', async () => {
    expect(runCli(['install', 'claude']).status).toBe(0);
    expect(runCli(['uninstall', 'claude']).status).toBe(0);
    // Re-running uninstall is still a clean no-op.
    expect(runCli(['uninstall', 'claude']).status).toBe(0);
    expect(
      memorizeCommandCount((await readJson(join(sandbox, '.claude', 'settings.local.json'))).hooks),
    ).toBe(0);
  });
});
