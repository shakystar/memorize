import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runHook } from '../harness/hook-runner.js';
import { claudeSessionStartPayload } from '../harness/fixtures.js';
import { listSessions } from '../../src/services/projection-store.js';
import { closeAll } from '../../src/storage/db.js';

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

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-hook-race-'));
  memorizeRoot = join(sandbox, '.memorize-home');
  await mkdir(join(sandbox, '.cursor', 'rules'), { recursive: true });
  await writeFile(
    join(sandbox, 'AGENTS.md'),
    '# Project guidance\nRace harness fixture.\n',
    'utf8',
  );
  await writeFile(
    join(sandbox, 'CLAUDE.md'),
    '# Claude guidance\nRace harness fixture.\n',
    'utf8',
  );
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('SessionStart task-claim race', () => {
  it('serializes concurrent SessionStart hooks so each session claims a distinct task', { timeout: 30_000 }, async () => {
    // Set up project + TWO active tasks. With two unclaimed candidates,
    // the rc.7 round-2 hole was that two SessionStart hooks could see
    // the same picker view and both claim task #1; the lock in
    // hook-service.ts:191-210 closes that window. With the lock,
    // session B's picker sees session A's claim (claimedTaskIds={T1})
    // and falls through to task #2 — the unclaimed candidate.
    const setup = runCli(['project', 'setup']);
    expect(setup.status).toBe(0);
    const t1 = runCli(['task', 'create', 'race', 'task', 'one']);
    expect(t1.status).toBe(0);
    const t2 = runCli(['task', 'create', 'race', 'task', 'two']);
    expect(t2.status).toBe(0);

    // Fire two SessionStart hooks (different agent session ids) as
    // concurrently as Promise.all permits.
    const [resultA, resultB] = await Promise.all([
      Promise.resolve().then(() =>
        runHook({
          agent: 'claude',
          event: 'SessionStart',
          payload: claudeSessionStartPayload('race-session-A'),
          sandbox,
          memorizeRoot,
        }),
      ),
      Promise.resolve().then(() =>
        runHook({
          agent: 'claude',
          event: 'SessionStart',
          payload: claudeSessionStartPayload('race-session-B'),
          sandbox,
          memorizeRoot,
        }),
      ),
    ]);

    expect(resultA.exitCode).toBe(0);
    expect(resultB.exitCode).toBe(0);

    // Two cwd pointers should exist (one per session) and each must
    // carry a taskId — both sessions claimed, but DIFFERENT tasks.
    const pointerFiles = await readdir(join(sandbox, '.memorize', 'sessions'));
    expect(pointerFiles.length).toBe(2);

    const pointers = await Promise.all(
      pointerFiles.map((name) =>
        readFile(join(sandbox, '.memorize', 'sessions', name), 'utf8').then(
          (body) =>
            JSON.parse(body) as {
              sessionId: string;
              taskId?: string;
              agentSessionId?: string;
            },
        ),
      ),
    );
    const taskIds = pointers.map((p) => p.taskId);
    expect(taskIds.every((id) => typeof id === 'string')).toBe(true);
    expect(new Set(taskIds).size).toBe(2);

    // Projection agrees: two distinct session.started records, each
    // with a distinct taskId. This is the invariant the file lock is
    // there to preserve.
    const projectsRoot = join(memorizeRoot, 'projects');
    const projectDirs = await readdir(projectsRoot);
    expect(projectDirs.length).toBe(1);
    process.env.MEMORIZE_ROOT = memorizeRoot;
    closeAll();
    const sessionRecords = listSessions(projectDirs[0]!);
    expect(sessionRecords.length).toBe(2);
    const projectionTaskIds = sessionRecords.map((s) => s.taskId);
    expect(projectionTaskIds.every((id) => typeof id === 'string')).toBe(true);
    expect(new Set(projectionTaskIds).size).toBe(2);
    expect(new Set(projectionTaskIds)).toEqual(new Set(taskIds));
  });
});
