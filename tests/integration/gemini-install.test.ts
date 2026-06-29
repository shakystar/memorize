import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
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

function runInit() {
  return spawnSync('node', [tsxCliPath, cliEntryPath, 'init'], {
    cwd: sandbox,
    encoding: 'utf8',
    env: {
      ...process.env,
      MEMORIZE_ROOT: memorizeRoot,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
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

const geminiSettings = () => join(fakeHome, '.gemini', 'settings.json');

interface HookEntry {
  command: string;
}
interface HookGroup {
  hooks: HookEntry[];
}

async function memorizeHookCount(file: string, event: string): Promise<number> {
  const parsed = JSON.parse(await readFile(file, 'utf8')) as {
    hooks?: Record<string, HookGroup[]>;
  };
  const groups = parsed.hooks?.[event] ?? [];
  return groups
    .flatMap((g) => g.hooks)
    .filter((h) => /memorize/.test(h.command) && /gemini/.test(h.command)).length;
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-gemini-'));
  fakeHome = join(sandbox, 'fake-home');
  memorizeRoot = join(sandbox, '.memorize-home');
  await mkdir(fakeHome, { recursive: true });
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('memorize init — gemini', () => {
  it('detects gemini via ~/.gemini and wires SessionStart + AfterTool hooks + ground rule', async () => {
    await mkdir(join(fakeHome, '.gemini'), { recursive: true });

    const result = runInit();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Initialized project');

    // Hooks registered in ~/.gemini/settings.json under gemini's NATIVE event
    // names — SessionStart (context injection) + AfterTool (capture).
    const settings = geminiSettings();
    expect(await pathExists(settings)).toBe(true);
    expect(await memorizeHookCount(settings, 'SessionStart')).toBe(1);
    expect(await memorizeHookCount(settings, 'AfterTool')).toBe(1);

    // GEMINI.md ground-rule planted.
    expect(await readFile(join(sandbox, 'GEMINI.md'), 'utf8')).toContain(
      'memorize:ground-rule',
    );

    // No other harness side effects.
    expect(
      await pathExists(join(sandbox, '.claude', 'settings.local.json')),
    ).toBe(false);
    expect(await pathExists(join(fakeHome, '.codex', 'hooks.json'))).toBe(false);
  });

  it('is idempotent: re-running leaves exactly one memorize hook per event and one ground-rule block', async () => {
    await mkdir(join(fakeHome, '.gemini'), { recursive: true });

    expect(runInit().status).toBe(0);
    expect(runInit().status).toBe(0);

    const settings = geminiSettings();
    expect(await memorizeHookCount(settings, 'SessionStart')).toBe(1);
    expect(await memorizeHookCount(settings, 'AfterTool')).toBe(1);

    const geminiMd = await readFile(join(sandbox, 'GEMINI.md'), 'utf8');
    const blocks = geminiMd.match(/memorize:ground-rule v=1 start/g) ?? [];
    expect(blocks).toHaveLength(1);
  });

  it('preserves a user-defined hook when registering memorize', async () => {
    const cfgDir = join(fakeHome, '.gemini');
    await mkdir(cfgDir, { recursive: true });
    await import('node:fs/promises').then((fs) =>
      fs.writeFile(
        join(cfgDir, 'settings.json'),
        JSON.stringify({
          hooks: {
            SessionStart: [
              { hooks: [{ type: 'command', command: 'echo user-hook' }] },
            ],
          },
        }),
        'utf8',
      ),
    );

    expect(runInit().status).toBe(0);

    const raw = await readFile(geminiSettings(), 'utf8');
    expect(raw).toContain('echo user-hook');
    expect(await memorizeHookCount(geminiSettings(), 'SessionStart')).toBe(1);
  });
});
