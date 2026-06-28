import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let sandbox: string;
let fakeHome: string;
let memorizeRoot: string;

const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

function runInit(cwd: string = sandbox, args: string[] = []) {
  return spawnSync('node', [tsxCliPath, cliEntryPath, 'init', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      MEMORIZE_ROOT: memorizeRoot,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      // Drive agent presence solely from the sandboxed HOME config dirs.
      MEMORIZE_DETECT_PATH: '',
      MEMORIZE_HOOK_COMMAND_FORM: 'npx',
    },
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

interface HookEntry {
  command: string;
}
interface HookGroup {
  hooks: HookEntry[];
}

async function memorizeHookCount(
  file: string,
  event: string,
): Promise<number> {
  const parsed = JSON.parse(await readFile(file, 'utf8')) as {
    hooks?: Record<string, HookGroup[]>;
  };
  const groups = parsed.hooks?.[event] ?? [];
  return groups
    .flatMap((g) => g.hooks)
    .filter((h) => /memorize/.test(h.command)).length;
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-init-'));
  fakeHome = join(sandbox, 'fake-home');
  memorizeRoot = join(sandbox, '.memorize-home');
  await mkdir(fakeHome, { recursive: true });
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('memorize init', () => {
  it('codex-only: binds project, wires codex globally, prints ACTION REQUIRED, writes no claude settings', async () => {
    await mkdir(join(fakeHome, '.codex'), { recursive: true });

    const result = runInit();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Initialized project');

    // Global codex hooks written.
    const codexHooks = join(fakeHome, '.codex', 'hooks.json');
    expect(await pathExists(codexHooks)).toBe(true);
    expect(await memorizeHookCount(codexHooks, 'SessionStart')).toBe(1);

    // Per-project AGENTS.md ground-rule block planted.
    expect(await readFile(join(sandbox, 'AGENTS.md'), 'utf8')).toContain(
      'memorize:ground-rule',
    );

    // Codex approval + sandbox notices surfaced.
    expect(result.stdout).toContain('ACTION REQUIRED');
    expect(result.stdout).toContain('writable_roots');

    // No claude wiring.
    expect(
      await pathExists(join(sandbox, '.claude', 'settings.local.json')),
    ).toBe(false);
  });

  it('claude-only: wires per-project hooks + skill + ground rule, no codex, no ACTION REQUIRED', async () => {
    await mkdir(join(fakeHome, '.claude'), { recursive: true });

    const result = runInit();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Initialized project');

    const settings = join(sandbox, '.claude', 'settings.local.json');
    expect(await pathExists(settings)).toBe(true);
    expect(await memorizeHookCount(settings, 'SessionStart')).toBe(1);

    expect(await readFile(join(sandbox, 'CLAUDE.md'), 'utf8')).toContain(
      'memorize:ground-rule',
    );
    expect(
      await pathExists(
        join(sandbox, '.claude', 'skills', 'using-memorize', 'SKILL.md'),
      ),
    ).toBe(true);

    // No codex side effects, no codex notice.
    expect(await pathExists(join(fakeHome, '.codex', 'hooks.json'))).toBe(false);
    expect(result.stdout).not.toContain('ACTION REQUIRED');
  });

  it('both present: wires claude AND codex with the codex notice', async () => {
    await mkdir(join(fakeHome, '.claude'), { recursive: true });
    await mkdir(join(fakeHome, '.codex'), { recursive: true });

    const result = runInit();
    expect(result.status).toBe(0);
    expect(
      await pathExists(join(sandbox, '.claude', 'settings.local.json')),
    ).toBe(true);
    expect(await pathExists(join(fakeHome, '.codex', 'hooks.json'))).toBe(true);
    expect(result.stdout).toContain('ACTION REQUIRED');
  });

  it('neither agent: still binds project + imports, prints guidance, writes no agent files', async () => {
    const result = runInit();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Initialized project');
    expect(result.stdout).toContain('No supported AI agent detected');

    expect(
      await pathExists(join(sandbox, '.claude', 'settings.local.json')),
    ).toBe(false);
    expect(await pathExists(join(fakeHome, '.codex', 'hooks.json'))).toBe(false);

    // The project really was created — `project show` resolves.
    const show = spawnSync(
      'node',
      [tsxCliPath, cliEntryPath, 'project', 'show'],
      {
        cwd: sandbox,
        encoding: 'utf8',
        env: {
          ...process.env,
          MEMORIZE_ROOT: memorizeRoot,
          HOME: fakeHome,
          USERPROFILE: fakeHome,
          MEMORIZE_DETECT_PATH: '',
        },
      },
    );
    expect(show.status).toBe(0);
  });

  it('imports existing context files', async () => {
    await mkdir(join(fakeHome, '.claude'), { recursive: true });
    await writeFile(join(sandbox, 'CLAUDE.md'), '# project rules\nbe nice\n');
    await writeFile(join(sandbox, '.cursorrules'), 'prefer small diffs\n');

    const result = runInit();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Imported context files: [1-9]/);
  });

  it('is idempotent: re-running leaves exactly one memorize hook per event', async () => {
    await mkdir(join(fakeHome, '.claude'), { recursive: true });

    expect(runInit().status).toBe(0);
    expect(runInit().status).toBe(0);

    const settings = join(sandbox, '.claude', 'settings.local.json');
    expect(await memorizeHookCount(settings, 'SessionStart')).toBe(1);
    expect(await memorizeHookCount(settings, 'PostToolUse')).toBe(1);

    // One ground-rule block, not two.
    const claudeMd = await readFile(join(sandbox, 'CLAUDE.md'), 'utf8');
    const blocks = claudeMd.match(/memorize:ground-rule v=1 start/g) ?? [];
    expect(blocks).toHaveLength(1);
  });

  it('refuses inside a bound ancestor without --nested, but creates a nested project with it', async () => {
    await mkdir(join(fakeHome, '.claude'), { recursive: true });
    // Bind the parent.
    expect(runInit(sandbox).status).toBe(0);

    const child = join(sandbox, 'packages', 'child');
    await mkdir(child, { recursive: true });

    // Without --nested → refusal, nothing created in the child.
    const refused = runInit(child);
    expect(refused.status).not.toBe(0);
    expect(`${refused.stdout}${refused.stderr}`).toContain(
      'memorize project init',
    );
    expect(
      await pathExists(join(child, '.claude', 'settings.local.json')),
    ).toBe(false);

    // With --nested → a separate nested project, agent wired.
    const nested = runInit(child, ['--nested']);
    expect(nested.status).toBe(0);
    expect(nested.stdout).toContain('Initialized nested project');
    expect(
      await pathExists(join(child, '.claude', 'settings.local.json')),
    ).toBe(true);
  });
});
