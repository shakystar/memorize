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

  it('Codex Stop is a no-op (β redesign — handoffs are agent-initiated)', async () => {
    // Codex's Stop fires per-turn (verified against Codex hook docs +
    // PR #14532's stop_hook_active mechanic). The rc.X auto-handoff
    // path produced one bogus handoff per turn here too. β model:
    // codex Stop returns `{}`, agents call `memorize handoff create`
    // explicitly when they actually want to hand off.
    runCli(['project', 'setup']);
    runCli(['task', 'create', 'Codex stop test']);

    const result = runCli(
      ['hook', 'codex', 'Stop'],
      JSON.stringify({
        cwd: sandbox,
        hook_event_name: 'Stop',
        session_id: 'codex-test-stop',
        last_assistant_message: 'Finished drafting the plan.',
      }),
    );

    expect(result.status).toBe(0);
    expect(String(result.stdout).trim()).toBe('{}');

    const projectsRoot = join(memorizeRoot, 'projects');
    const { readdir } = await import('node:fs/promises');
    const projectDirs = await readdir(projectsRoot);
    const handoffsDir = join(projectsRoot, projectDirs[0]!, 'handoffs');
    const files = await readdir(handoffsDir).catch(() => []);
    expect(files.length).toBe(0);
  });
});
