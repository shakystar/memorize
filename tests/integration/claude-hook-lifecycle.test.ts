import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let sandbox: string;
let memorizeRoot: string;

const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

function runHook(eventName: string, stdinPayload: object) {
  return spawnSync('node', [tsxCliPath, cliEntryPath, 'hook', 'claude', eventName], {
    cwd: sandbox,
    input: JSON.stringify(stdinPayload),
    encoding: 'utf8',
    env: {
      ...process.env,
      MEMORIZE_ROOT: memorizeRoot,
    },
  });
}

function runCli(args: string[]) {
  return spawnSync('node', [tsxCliPath, cliEntryPath, ...args], {
    cwd: sandbox,
    encoding: 'utf8',
    env: {
      ...process.env,
      MEMORIZE_ROOT: memorizeRoot,
    },
  });
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-hook-lifecycle-'));
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

describe('claude hook lifecycle', () => {
  it('creates checkpoint artifacts on PostCompact', async () => {
    const sessionStart = runHook('SessionStart', {
      cwd: sandbox,
      hook_event_name: 'SessionStart',
      session_id: 'session_1',
    });
    expect(sessionStart.status).toBe(0);

    const result = runHook('PostCompact', {
      cwd: sandbox,
      hook_event_name: 'PostCompact',
      session_id: 'session_1',
      compact_summary: 'Summarized recent progress',
    });

    expect(result.status).toBe(0);
    // PostCompact output must be a plain top-level `systemMessage` —
    // Claude Code rejects a `hookSpecificOutput` block on this event.
    expect(result.stdout).not.toContain('"hookSpecificOutput"');
    expect(result.stdout).toContain('"systemMessage"');
    expect(result.stdout).toContain('memorize: checkpoint');

    const projectsRoot = join(memorizeRoot, 'projects');
    const projectDirs = await readdir(projectsRoot);
    const checkpointsDir = join(projectsRoot, projectDirs[0]!, 'checkpoints');
    const checkpointFiles = await readdir(checkpointsDir);
    expect(checkpointFiles.length).toBeGreaterThan(0);
  });

  it('Stop hook is a no-op (β redesign — handoffs are agent-initiated, not per-turn)', async () => {
    // rc.0..rc.4 wired Stop to auto-create a handoff every time the
    // assistant finished a turn. That conflated "turn end" with
    // "session end" and produced one bogus handoff per turn. β model:
    // Stop returns `{}`, agents call `memorize handoff create`
    // explicitly when they actually want to hand off.
    const sessionStart = runHook('SessionStart', {
      cwd: sandbox,
      hook_event_name: 'SessionStart',
      session_id: 'session_2',
    });
    expect(sessionStart.status).toBe(0);

    runCli(['task', 'create', 'Test task']);

    const result = runHook('Stop', {
      cwd: sandbox,
      hook_event_name: 'Stop',
      session_id: 'session_2',
      last_assistant_message: 'Finished the current pass.',
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');

    const projectsRoot = join(memorizeRoot, 'projects');
    const projectDirs = await readdir(projectsRoot);
    const handoffsDir = join(projectsRoot, projectDirs[0]!, 'handoffs');
    const handoffFiles = await readdir(handoffsDir).catch(() => []);
    expect(handoffFiles.length).toBe(0);
  });

  it('SessionEnd hook writes session.completed and unlinks the cwd pointer', async () => {
    const sessionStart = runHook('SessionStart', {
      cwd: sandbox,
      hook_event_name: 'SessionStart',
      session_id: 'c0000000-0000-0000-0000-000000000099',
    });
    expect(sessionStart.status).toBe(0);

    const sessionsBefore = await readdir(join(sandbox, '.memorize', 'sessions'));
    expect(sessionsBefore.length).toBe(1);
    const memorizeSessionId = sessionsBefore[0]!.replace(/\.json$/, '');

    // Production env propagation goes through CLAUDE_ENV_FILE → source →
    // exported MEMORIZE_SESSION_ID; in-test we pass it directly so the
    // SessionEnd subprocess can resolve the pointer.
    const sessionEnd = spawnSync(
      'node',
      [tsxCliPath, cliEntryPath, 'hook', 'claude', 'SessionEnd'],
      {
        cwd: sandbox,
        input: JSON.stringify({
          cwd: sandbox,
          hook_event_name: 'SessionEnd',
          session_id: 'c0000000-0000-0000-0000-000000000099',
          reason: 'logout',
        }),
        encoding: 'utf8',
        env: {
          ...process.env,
          MEMORIZE_ROOT: memorizeRoot,
          MEMORIZE_SESSION_ID: memorizeSessionId,
        },
      },
    );
    expect(sessionEnd.status).toBe(0);

    // Cwd pointer gone.
    const sessionsAfter = await readdir(join(sandbox, '.memorize', 'sessions')).catch(
      () => [] as string[],
    );
    expect(sessionsAfter.length).toBe(0);

    // session.completed event landed in the project log.
    const projectsRoot = join(memorizeRoot, 'projects');
    const projectDirs = await readdir(projectsRoot);
    const events = await readdir(join(projectsRoot, projectDirs[0]!, 'events'));
    let sawCompleted = false;
    for (const ev of events) {
      const body = await readFile(
        join(projectsRoot, projectDirs[0]!, 'events', ev),
        'utf8',
      );
      if (body.includes('"session.completed"')) sawCompleted = true;
    }
    expect(sawCompleted).toBe(true);
  });
});
