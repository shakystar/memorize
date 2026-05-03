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

function runHook(
  eventName: string,
  stdinPayload: object,
  extraEnv: Record<string, string> = {},
) {
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
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-task-aware-hook-'));
  memorizeRoot = join(sandbox, '.memorize-home');
  await mkdir(join(sandbox, '.cursor', 'rules'), { recursive: true });
  await writeFile(join(sandbox, 'AGENTS.md'), '# Project guidance\nUse small commits.\n', 'utf8');
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('task-aware hook semantics', () => {
  it('attaches PostCompact checkpoints to the current active task', async () => {
    runCli(['project', 'setup']);
    const createTask = runCli(['task', 'create', 'Wire', 'task-aware', 'checkpoint']);
    expect(createTask.status).toBe(0);

    const result = runHook('PostCompact', {
      cwd: sandbox,
      hook_event_name: 'PostCompact',
      session_id: 'session_task_1',
      compact_summary: 'Task-aware compact summary',
    });
    expect(result.status).toBe(0);

    const projectDirs = await readdir(join(memorizeRoot, 'projects'));
    const taskFiles = await readdir(join(memorizeRoot, 'projects', projectDirs[0]!, 'tasks'));
    const taskContent = await readFile(
      join(memorizeRoot, 'projects', projectDirs[0]!, 'tasks', taskFiles[0]!),
      'utf8',
    );

    expect(taskContent).toContain('latestCheckpointId');
  });

  it('attaches Stop handoffs to the current active task', async () => {
    runCli(['project', 'setup']);
    runCli(['task', 'create', 'Wire', 'task-aware', 'handoff']);

    const result = runHook('Stop', {
      cwd: sandbox,
      hook_event_name: 'Stop',
      session_id: 'session_task_2',
      last_assistant_message: 'Task-aware stop summary',
    });
    expect(result.status).toBe(0);

    const projectDirs = await readdir(join(memorizeRoot, 'projects'));
    const taskFiles = await readdir(join(memorizeRoot, 'projects', projectDirs[0]!, 'tasks'));
    const taskContent = await readFile(
      join(memorizeRoot, 'projects', projectDirs[0]!, 'tasks', taskFiles[0]!),
      'utf8',
    );

    expect(taskContent).toContain('latestHandoffId');
    expect(taskContent).toContain('handoff_ready');
  });

  it('Stop hook completes the calling session and unlinks its cwd pointer (rc.4 Gap D)', async () => {
    // Regression for rc.4 Gap D: handleStop used to forward the agent's
    // payload session_id (Claude UUID) to endSession, which looked up a
    // pointer that did not exist and silently no-op'd. Result: handoffs
    // got written but session.completed events never fired and pointer
    // files leaked, so the projection accumulated dead "active"
    // sessions that blocked the picker indefinitely.
    runCli(['project', 'setup']);
    runCli(['task', 'create', 'Gap', 'D', 'regression']);

    // Pretend a SessionStart fired and stamped a memorize-side pointer.
    const sessionStart = runHook('SessionStart', {
      cwd: sandbox,
      hook_event_name: 'SessionStart',
      session_id: 'c0000000-0000-0000-0000-000000000001',
    });
    expect(sessionStart.status).toBe(0);

    const sessionsBefore = await readdir(join(sandbox, '.memorize', 'sessions'));
    expect(sessionsBefore.length).toBe(1);
    const memorizeSessionId = sessionsBefore[0]!.replace(/\.json$/, '');

    // Drive Stop with a payload whose session_id is an agent-shaped
    // UUID (unrelated to the memorize session id) — exactly the wire
    // format Claude uses. Production env propagation goes through
    // CLAUDE_ENV_FILE → source → exported MEMORIZE_SESSION_ID; in this
    // test we set it directly so the Stop subprocess can resolve the
    // pointer the way real Claude tool subprocesses do.
    const stop = runHook(
      'Stop',
      {
        cwd: sandbox,
        hook_event_name: 'Stop',
        session_id: 'c0000000-0000-0000-0000-000000000001',
        last_assistant_message: 'Gap D regression',
      },
      { MEMORIZE_SESSION_ID: memorizeSessionId },
    );
    expect(stop.status).toBe(0);

    // Pointer file for the just-ended session must be gone.
    const sessionsAfter = await readdir(join(sandbox, '.memorize', 'sessions')).catch(
      () => [] as string[],
    );
    expect(sessionsAfter.length).toBe(0);

    // session.completed must appear in the project event log so the
    // projection no longer counts this session as active.
    const projectDirs = await readdir(join(memorizeRoot, 'projects'));
    const events = await readdir(join(memorizeRoot, 'projects', projectDirs[0]!, 'events'));
    let sawCompleted = false;
    for (const ev of events) {
      const body = await readFile(
        join(memorizeRoot, 'projects', projectDirs[0]!, 'events', ev),
        'utf8',
      );
      if (body.includes('"session.completed"')) {
        sawCompleted = true;
        break;
      }
    }
    expect(sawCompleted).toBe(true);
  });
});
