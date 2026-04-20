import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let sandbox: string;
let memorizeRoot: string;

const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

function runCli(args: string[], stdinPayload?: string) {
  return spawnSync('node', [tsxCliPath, cliEntryPath, ...args], {
    cwd: sandbox,
    input: stdinPayload,
    encoding: 'utf8',
    env: { ...process.env, MEMORIZE_ROOT: memorizeRoot },
  });
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-codex-runtime-'));
  memorizeRoot = join(sandbox, '.memorize-home');
  await writeFile(
    join(sandbox, 'AGENTS.md'),
    '# Project rules\nSmall commits only.\n',
    'utf8',
  );
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('codex hook runtime', () => {
  it('returns startup context on SessionStart for a bound project', () => {
    // Setup project so the codex hook has something to surface.
    runCli(['project', 'setup']);

    const result = runCli(
      ['hook', 'codex', 'SessionStart'],
      JSON.stringify({
        cwd: sandbox,
        hook_event_name: 'SessionStart',
        session_id: 'codex-test-1',
      }),
    );

    expect(result.status).toBe(0);
    const parsed = JSON.parse(String(result.stdout)) as {
      hookSpecificOutput?: {
        hookEventName: string;
        additionalContext?: string;
      };
    };
    expect(parsed.hookSpecificOutput?.hookEventName).toBe('SessionStart');
    expect(parsed.hookSpecificOutput?.additionalContext).toContain(
      'Small commits only',
    );
  });

  it('returns an empty object when cwd is not a memorize-bound project', () => {
    // No `project setup` — cwd has no binding.
    const result = runCli(
      ['hook', 'codex', 'SessionStart'],
      JSON.stringify({
        cwd: sandbox,
        hook_event_name: 'SessionStart',
        session_id: 'codex-test-unbound',
      }),
    );

    expect(result.status).toBe(0);
    expect(String(result.stdout).trim()).toBe('{}');
  });

  it('returns an empty object for unknown hook events', () => {
    runCli(['project', 'setup']);

    const result = runCli(
      ['hook', 'codex', 'PreToolUse'],
      JSON.stringify({ cwd: sandbox, hook_event_name: 'PreToolUse' }),
    );

    expect(result.status).toBe(0);
    expect(String(result.stdout).trim()).toBe('{}');
  });
});
