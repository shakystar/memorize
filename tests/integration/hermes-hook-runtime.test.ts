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

function runHermesHook(event: string, payload: object) {
  return spawnSync(
    'node',
    [tsxCliPath, cliEntryPath, 'hook', 'hermes', event],
    {
      cwd: sandbox,
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: baseEnv(),
    },
  );
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-hermes-rt-'));
  fakeHome = join(sandbox, 'fake-home');
  memorizeRoot = join(sandbox, '.memorize-home');
  await mkdir(fakeHome, { recursive: true });
  // Bind the cwd to a memorize project — hermes hooks are global (no
  // auto-bind), so the runner returns the empty result until a binding exists.
  expect(runInit().status).toBe(0);
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('hermes hook runtime — wire translation + per-session injection gate', () => {
  it('pre_llm_call injects {context} on the FIRST turn and {} on later turns of the same session', async () => {
    const payload = {
      hook_event_name: 'pre_llm_call',
      session_id: 'hermes_sess_1',
      cwd: sandbox,
    };

    // Turn 1: no memorize session yet for this session_id → inject context in
    // hermes's native wire shape ({"context": "..."}), NOT Claude's envelope.
    const first = runHermesHook('pre_llm_call', payload);
    expect(first.status).toBe(0);
    const firstOut = JSON.parse(first.stdout) as { context?: string };
    expect(typeof firstOut.context).toBe('string');
    expect(firstOut.context!.length).toBeGreaterThan(0);
    // Translation, not passthrough: the Claude-only envelope must be gone.
    expect(first.stdout).not.toContain('hookSpecificOutput');
    expect(first.stdout).not.toContain('additionalContext');

    // Turn 2 (same session_id): the gate finds the existing session and skips
    // re-injection — empty envelope, no context.
    const second = runHermesHook('pre_llm_call', payload);
    expect(second.status).toBe(0);
    const secondOut = JSON.parse(second.stdout) as { context?: string };
    expect(secondOut.context).toBeUndefined();
    expect(second.stdout.replace(/\s/g, '')).toBe('{}');
  });

  it('a DIFFERENT session_id injects again (gate is per agent session)', async () => {
    const out1 = runHermesHook('pre_llm_call', {
      session_id: 'sess_A',
      cwd: sandbox,
    });
    const out2 = runHermesHook('pre_llm_call', {
      session_id: 'sess_B',
      cwd: sandbox,
    });
    expect((JSON.parse(out1.stdout) as { context?: string }).context).toBeTruthy();
    expect((JSON.parse(out2.stdout) as { context?: string }).context).toBeTruthy();
  });

  it('observer events (post_tool_call / on_session_finalize) never emit a context envelope', async () => {
    // post_tool_call is capture-only; hermes ignores its stdout.
    const capture = runHermesHook('post_tool_call', {
      tool_name: 'terminal',
      tool_input: { command: 'rm -rf build' },
      cwd: sandbox,
    });
    expect(capture.status).toBe(0);
    expect(capture.stdout).not.toContain('context');

    const finalize = runHermesHook('on_session_finalize', {
      session_id: 'hermes_sess_1',
      cwd: sandbox,
    });
    expect(finalize.status).toBe(0);
    expect(finalize.stdout).not.toContain('"context"');
  });
});
