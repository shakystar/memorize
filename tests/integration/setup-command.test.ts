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

function runSetup() {
  return spawnSync('node', [tsxCliPath, cliEntryPath, 'setup'], {
    cwd: sandbox,
    encoding: 'utf8',
    env: {
      ...process.env,
      MEMORIZE_ROOT: memorizeRoot,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      // Disable PATH-based agent detection so presence is driven solely by
      // the sandboxed HOME config dirs each test creates. ('' is non-nullish,
      // so it wins over the real PATH in agent-detect's ?? fallback.)
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

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-setup-'));
  fakeHome = join(sandbox, 'fake-home');
  memorizeRoot = join(sandbox, '.memorize-home');
  await mkdir(fakeHome, { recursive: true });
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('memorize setup', () => {
  it('wires codex globally when ~/.codex exists, and stays silent on claude', async () => {
    await mkdir(join(fakeHome, '.codex'), { recursive: true });

    const result = runSetup();
    expect(result.status).toBe(0);

    const hooks = JSON.parse(
      await readFile(join(fakeHome, '.codex', 'hooks.json'), 'utf8'),
    ) as { hooks: Record<string, unknown> };
    expect(hooks.hooks.SessionStart).toBeTruthy();

    expect(result.stdout).toContain('Codex');
    expect(result.stdout).not.toContain('memorize install claude');
  });

  it('instructs for claude (per-project) without writing any codex file', async () => {
    await mkdir(join(fakeHome, '.claude'), { recursive: true });

    const result = runSetup();
    expect(result.status).toBe(0);

    expect(await pathExists(join(fakeHome, '.codex', 'hooks.json'))).toBe(false);
    expect(result.stdout).toContain('memorize install claude');
  });

  it('prints guidance when no agent is detected', async () => {
    const result = runSetup();
    expect(result.status).toBe(0);

    expect(await pathExists(join(fakeHome, '.codex', 'hooks.json'))).toBe(false);
    expect(result.stdout).toContain('No supported AI agent detected');
  });

  it('wires codex AND instructs for claude when both are present', async () => {
    await mkdir(join(fakeHome, '.codex'), { recursive: true });
    await mkdir(join(fakeHome, '.claude'), { recursive: true });

    const result = runSetup();
    expect(result.status).toBe(0);

    const hooks = JSON.parse(
      await readFile(join(fakeHome, '.codex', 'hooks.json'), 'utf8'),
    ) as { hooks: Record<string, unknown> };
    expect(hooks.hooks.SessionStart).toBeTruthy();

    expect(result.stdout).toContain('Codex');
    expect(result.stdout).toContain('memorize install claude');
  });
});
