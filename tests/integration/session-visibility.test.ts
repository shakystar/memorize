import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

let sandbox: string;
let memorizeRoot: string;

function runCli(
  args: string[],
  stdinPayload?: object,
  envOverride?: Record<string, string>,
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MEMORIZE_ROOT: memorizeRoot,
    // Sessions in this test are synthetic; disable staleness filtering.
    MEMORIZE_STALE_SESSION_MS: '0',
  };
  // The test runner itself may be running INSIDE a memorize-instrumented
  // agent session — its session env var would leak into the child CLI and
  // win session resolution, mis-attributing captures to a session that
  // does not exist in the sandbox project. Tests re-add it per call to
  // emulate a real per-session environment.
  delete env.MEMORIZE_SESSION_ID;
  Object.assign(env, envOverride);
  return spawnSync(process.execPath, [tsxCliPath, cliEntryPath, ...args], {
    cwd: sandbox,
    encoding: 'utf8',
    env,
    ...(stdinPayload ? { input: JSON.stringify(stdinPayload) } : {}),
  });
}

function hookPayload(sessionId: string, extra: object = {}): object {
  return { cwd: sandbox, session_id: sessionId, ...extra };
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-sessvis-'));
  memorizeRoot = join(sandbox, '.memorize-home');
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('memorize session list / activity (#83 — the macOS user scenario)', () => {
  it('answers "what are my other sessions doing?" across parallel sessions', async () => {
    // Two parallel sessions on one project — like the original report: a
    // working session and one that captures nothing (plan-mode-ish).
    expect(
      runCli(
        ['hook', 'claude', 'SessionStart'],
        hookPayload('sess-planner', { hook_event_name: 'SessionStart' }),
      ).status,
    ).toBe(0);
    expect(
      runCli(
        ['hook', 'claude', 'SessionStart'],
        hookPayload('sess-worker', { hook_event_name: 'SessionStart' }),
      ).status,
    ).toBe(0);

    // Resolve the memorize session ids (sorted lastSeenAt desc → worker first).
    const ids = (
      JSON.parse(runCli(['session', 'list', '--json']).stdout) as Array<{
        id: string;
      }>
    ).map((entry) => entry.id);
    const workerId = ids[0]!;

    // Only the worker session captures activity. Session attribution rides
    // the per-session env var, as in a real instrumented agent process —
    // the ancestor-pid fallback heuristics are not what this test targets.
    expect(
      runCli(
        ['hook', 'claude', 'PostToolUse'],
        hookPayload('sess-worker', {
          hook_event_name: 'PostToolUse',
          tool_name: 'Write',
          tool_input: { file_path: join(sandbox, 'feature.ts') },
        }),
        { MEMORIZE_SESSION_ID: workerId },
      ).status,
    ).toBe(0);

    const list = runCli(['session', 'list', '--json']);
    expect(list.status).toBe(0);
    const sessions = JSON.parse(list.stdout) as Array<{
      actor: string;
      status: string;
      observations: unknown[];
    }>;
    expect(sessions).toHaveLength(2);
    for (const session of sessions) {
      expect(session.actor).toBe('claude');
      expect(session.status).toBe('active');
      expect(session.observations).toEqual([]); // list = no activity payload
    }

    const activity = runCli(['session', 'activity', '--json'], undefined, {
      MEMORIZE_SESSION_ID: workerId,
    });
    expect(activity.status).toBe(0);
    const entries = JSON.parse(activity.stdout) as Array<{
      self: boolean;
      observations: Array<{ signal: string; summary?: string }>;
    }>;
    const withWork = entries.filter((e) => e.observations.length > 0);
    const idle = entries.filter((e) => e.observations.length === 0);
    expect(withWork).toHaveLength(1);
    expect(withWork[0]!.observations[0]!.signal).toBe('write-tool');
    expect(withWork[0]!.observations[0]!.summary).toContain('feature.ts');
    expect(withWork[0]!.self).toBe(true); // asking session is marked
    // The quiet session is SHOWN, not omitted (honest empty state).
    expect(idle).toHaveLength(1);

    // Human-readable form marks the empty session explicitly.
    const human = runCli(['session', 'activity']);
    expect(human.stdout).toContain('2 active session(s)');
    expect(human.stdout).toContain('(no captured activity yet)');
  });

  it('prints a sensible empty state instead of silence', async () => {
    // Bind the project WITHOUT any agent session (project setup only).
    expect(runCli(['project', 'setup']).status).toBe(0);

    const result = runCli(['session', 'list']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('no active sessions');
  });
});

describe('memorize version (#82)', () => {
  it('prints the package version of the binary that ran', async () => {
    const pkg = JSON.parse(
      await readFile(join(repoRoot, 'package.json'), 'utf8'),
    ) as { version: string };
    for (const flag of ['version', '--version', '-v']) {
      const result = runCli([flag]);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(pkg.version);
    }
  });
});
