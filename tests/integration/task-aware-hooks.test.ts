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

  it('SessionEnd hook pauses the calling session and PRESERVES the cwd pointer (Model C)', async () => {
    // Model C lifecycle: SessionEnd writes session.paused and keeps
    // the cwd pointer on disk so a subsequent `claude --resume` /
    // `codex resume` can reattach via agentSessionId match. The old
    // Model A behavior (mark completed + unlink) broke that resume
    // path because resolveByAgentSessionId only sees pointers, not
    // projection records. Reap still catches a paused session that
    // goes stale without a resume.
    runCli(['project', 'setup']);
    runCli(['task', 'create', 'SessionEnd', 'regression']);

    const sessionStart = runHook('SessionStart', {
      cwd: sandbox,
      hook_event_name: 'SessionStart',
      session_id: 'c0000000-0000-0000-0000-000000000001',
    });
    expect(sessionStart.status).toBe(0);

    const sessionsBefore = await readdir(join(sandbox, '.memorize', 'sessions'));
    expect(sessionsBefore.length).toBe(1);
    const memorizeSessionId = sessionsBefore[0]!.replace(/\.json$/, '');

    const sessionEnd = runHook(
      'SessionEnd',
      {
        cwd: sandbox,
        hook_event_name: 'SessionEnd',
        session_id: 'c0000000-0000-0000-0000-000000000001',
        reason: 'logout',
      },
      { MEMORIZE_SESSION_ID: memorizeSessionId },
    );
    expect(sessionEnd.status).toBe(0);

    // Pointer survives — Model C invariant.
    const sessionsAfter = await readdir(join(sandbox, '.memorize', 'sessions'));
    expect(sessionsAfter).toEqual([`${memorizeSessionId}.json`]);

    const projectDirs = await readdir(join(memorizeRoot, 'projects'));
    const events = await readdir(join(memorizeRoot, 'projects', projectDirs[0]!, 'events'));
    let sawPaused = false;
    let sawCompleted = false;
    for (const ev of events) {
      const body = await readFile(
        join(memorizeRoot, 'projects', projectDirs[0]!, 'events', ev),
        'utf8',
      );
      if (body.includes('"session.paused"')) sawPaused = true;
      if (body.includes('"session.completed"')) sawCompleted = true;
    }
    expect(sawPaused).toBe(true);
    expect(sawCompleted).toBe(false);
  });
});
