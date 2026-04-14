import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let sandbox: string;
let memorizeRoot: string;

const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

function runHook(eventName: string, stdinPayload: object, extraEnv: Record<string, string> = {}) {
  return spawnSync('node', [tsxCliPath, cliEntryPath, 'hook', 'claude', eventName], {
    cwd: sandbox,
    input: JSON.stringify(stdinPayload),
    encoding: 'utf8',
    env: {
      ...process.env,
      MEMORIZE_ROOT: memorizeRoot,
      ...extraEnv,
    },
  });
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-hook-'));
  memorizeRoot = join(sandbox, '.memorize-home');
  await mkdir(join(sandbox, '.cursor', 'rules'), { recursive: true });
  await writeFile(
    join(sandbox, 'AGENTS.md'),
    '# Project guidance\nUse small commits and keep handoffs explicit.\n',
    'utf8',
  );
  await writeFile(
    join(sandbox, 'CLAUDE.md'),
    '# Claude guidance\nPrioritize architectural consistency.\n',
    'utf8',
  );
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('claude hook integration', () => {
  it('returns additional context on SessionStart and persists env vars', async () => {
    const envFile = join(sandbox, 'claude.env');
    const result = runHook(
      'SessionStart',
      {
        cwd: sandbox,
        hook_event_name: 'SessionStart',
        session_id: 'session_1',
      },
      {
        CLAUDE_ENV_FILE: envFile,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"hookEventName":"SessionStart"');
    expect(result.stdout).toContain('Use small commits and keep handoffs explicit');

    const persistedEnv = await readFile(envFile, 'utf8');
    expect(persistedEnv).toContain('MEMORIZE_PROJECT_ID=');
    expect(persistedEnv).toContain('MEMORIZE_BOOTSTRAP_FILE=');
  });
});
