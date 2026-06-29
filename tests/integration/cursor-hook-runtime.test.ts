import { mkdtemp, mkdir, rm } from 'node:fs/promises';
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

const baseEnv = () => ({
  ...process.env,
  MEMORIZE_ROOT: memorizeRoot,
  HOME: fakeHome,
  USERPROFILE: fakeHome,
  MEMORIZE_DETECT_PATH: '',
});

function runInit() {
  return spawnSync('node', [tsxCliPath, cliEntryPath, 'init'], {
    cwd: sandbox,
    encoding: 'utf8',
    env: baseEnv(),
  });
}

function runCursorHook(event: string, payload: object) {
  return spawnSync('node', [tsxCliPath, cliEntryPath, 'hook', 'cursor', event], {
    cwd: sandbox,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: baseEnv(),
  });
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-cursor-rt-'));
  fakeHome = join(sandbox, 'fake-home');
  memorizeRoot = join(sandbox, '.memorize-home');
  await mkdir(fakeHome, { recursive: true });
  // cursor auto-binds (project-scoped hooks), but init makes the binding
  // explicit so the run is deterministic regardless of auto-bind ordering.
  expect(runInit().status).toBe(0);
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('cursor hook runtime — additional_context wire translation', () => {
  it('sessionStart injects memory under the native {additional_context} field, not Claude’s envelope', async () => {
    const out = runCursorHook('sessionStart', {
      hook_event_name: 'sessionStart',
      session_id: 'cursor_sess_1',
      cwd: sandbox,
    });
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout) as { additional_context?: string };
    expect(typeof parsed.additional_context).toBe('string');
    expect(parsed.additional_context!.length).toBeGreaterThan(0);
    // Translation, not passthrough: the Claude-only envelope must be gone, and
    // the field must be snake_case (cursor), not camelCase (claude).
    expect(out.stdout).not.toContain('hookSpecificOutput');
    expect(out.stdout).not.toContain('additionalContext');
  });

  it('postToolUse (Shell) runs capture and emits no context envelope when no sibling is active', async () => {
    const out = runCursorHook('postToolUse', {
      hook_event_name: 'postToolUse',
      tool_name: 'Shell',
      tool_input: { command: 'rm -rf build' },
      cwd: sandbox,
    });
    expect(out.status).toBe(0);
    // No parallel session → live-update is silent → empty envelope.
    expect(out.stdout.replace(/\s/g, '')).toBe('{}');
  });

  it('preCompact and sessionEnd are boundaries: they emit no context envelope', async () => {
    const precompact = runCursorHook('preCompact', {
      hook_event_name: 'preCompact',
      session_id: 'cursor_sess_1',
      cwd: sandbox,
    });
    expect(precompact.status).toBe(0);
    // PostCompact handler returns {systemMessage}; the cursor wire renderer
    // collapses every non-context result to {}.
    expect(precompact.stdout).not.toContain('additional_context');

    const sessionEnd = runCursorHook('sessionEnd', {
      hook_event_name: 'sessionEnd',
      session_id: 'cursor_sess_1',
      cwd: sandbox,
    });
    expect(sessionEnd.status).toBe(0);
    expect(sessionEnd.stdout).not.toContain('additional_context');
  });
});
