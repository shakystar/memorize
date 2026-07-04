import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createProject,
  getBoundProjectId,
  readProject,
  recordDecision,
} from '../../src/services/project-service.js';
import { createTask, readHandoff, readTask } from '../../src/services/task-service.js';
import { loadStartContext } from '../../src/services/context-service.js';
import { resolveConflict } from '../../src/services/conflict-service.js';
import {
  getConflict,
  rebuildProjectProjection,
} from '../../src/services/projection-store.js';
import { appendEvent } from '../../src/storage/event-store.js';
import { createConflict } from '../../src/domain/entities.js';
import { SESSION_ENV_VAR, startSession } from '../../src/services/session-service.js';
import { closeAll } from '../../src/storage/db.js';
import { readJson } from '../../src/storage/fs-utils.js';
import { getSyncFile } from '../../src/storage/path-resolver.js';
import type { ProjectSyncState } from '../../src/domain/entities.js';

let sandbox: string;
let memorizeRoot: string;
let previousMemorizeRoot: string | undefined;
const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

function runCli(args: string[]): ReturnType<typeof spawnSync> {
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
  // realpath because macOS mkdtemp returns the symlinked /var/folders
  // path while spawned subprocesses see the canonical /private/var
  // form via process.cwd(). The bindings store keys by absolute path,
  // so the two views must agree or `requireBoundProjectId` misses.
  sandbox = await realpath(await mkdtemp(join(tmpdir(), 'memorize-phase2-')));
  memorizeRoot = join(sandbox, '.memorize-home');
  // In-process service calls resolve MEMORIZE_ROOT from process.env
  // (falling back to the real ~/.memorize), so plant the sandbox root
  // for every test — not just the CLI subprocesses spawned via runCli.
  previousMemorizeRoot = process.env.MEMORIZE_ROOT;
  process.env.MEMORIZE_ROOT = memorizeRoot;
});

afterEach(async () => {
  if (previousMemorizeRoot === undefined) delete process.env.MEMORIZE_ROOT;
  else process.env.MEMORIZE_ROOT = previousMemorizeRoot;
  closeAll();
  await rm(sandbox, { recursive: true, force: true });
});

describe('phase 2 services and cli', () => {
  it('creates project/task via services and loads startup context', async () => {
    const project = await createProject({
      title: 'Memorize',
      rootPath: sandbox,
      summary: 'Shared context system',
    });
    const task = await createTask({
      projectId: project.id,
      title: 'Implement services',
      actor: 'codex',
    });

    const storedTask = await readTask(project.id, task.id);
    const startup = await loadStartContext({
      projectId: project.id,
      taskId: task.id,
    });

    expect(storedTask?.title).toBe('Implement services');
    expect(startup.task?.id).toBe(task.id);
    expect(startup.projectSummary).toBe('Shared context system');
  });

  it('supports thin cli commands for project and task flows', { timeout: 30_000 }, () => {
    const init = runCli(['project', 'init']);
    expect(init.status).toBe(0);
    expect(init.stdout).toContain('Initialized project');

    const showProject = runCli(['project', 'show']);
    expect(showProject.status).toBe(0);
    expect(showProject.stdout).toContain('"title"');

    const createTaskResult = runCli(['task', 'create', 'Create', 'a', 'task']);
    expect(createTaskResult.status).toBe(0);
    expect(createTaskResult.stdout).toContain('Created task');

    const resumeResult = runCli(['task', 'resume']);
    expect(resumeResult.status).toBe(0);
    expect(resumeResult.stdout).toContain('"projectSummary"');

    const syncResult = runCli(['project', 'sync']);
    expect(syncResult.status).toBe(0);
    expect(syncResult.stdout).toContain('Project sync state');
  });

  it('task resume loads an explicit task and rejects unknown flags', { timeout: 30_000 }, () => {
    const init = runCli(['project', 'init']);
    expect(init.status).toBe(0);

    const created = runCli(['task', 'create', 'Resume', 'target']);
    expect(created.status).toBe(0);
    const taskId = String(created.stdout).trim().replace(/^Created task /, '');

    // `--task <id>` (and positional) now load that task's startup
    // context instead of being silently swallowed.
    const byFlag = runCli(['task', 'resume', '--task', taskId]);
    expect(byFlag.status).toBe(0);
    expect(byFlag.stdout).toContain(taskId);

    const byPositional = runCli(['task', 'resume', taskId]);
    expect(byPositional.status).toBe(0);
    expect(byPositional.stdout).toContain(taskId);

    // Fail loud: a typo'd flag no longer no-ops into a plausible payload.
    const bogus = runCli(['task', 'resume', '--bogus']);
    expect(bogus.status).not.toBe(0);

    // Fail loud: an explicit but unresolved task id must not silently
    // fall back to the auto-picker and return a different task.
    const missing = runCli(['task', 'resume', '--task', 'task_does_not_exist']);
    expect(missing.status).not.toBe(0);
    expect(String(missing.stderr)).toContain('task_does_not_exist');
  });

  it('records task checkpoint and handoff via cli', { timeout: 30_000 }, () => {
    const init = runCli(['project', 'init']);
    expect(init.status).toBe(0);

    const createTaskResult = runCli(['task', 'create', 'Finish', 'wiring']);
    expect(createTaskResult.status).toBe(0);

    const checkpoint = runCli([
      'task',
      'checkpoint',
      '--summary',
      'Halfway through wiring',
      '--task-update',
      'flag parser added',
      '--deferred',
      'polish error messages',
    ]);
    expect(checkpoint.status).toBe(0);
    expect(checkpoint.stdout).toContain('Created checkpoint');

    expect(runCli(['task', 'start']).status).toBe(0);

    const handoff = runCli([
      'task',
      'handoff',
      '--summary',
      'Ready for codex',
      '--next',
      'Continue from handoff notes',
      '--done',
      'cli stubs replaced',
      '--remaining',
      'add golden tests',
      '--confidence',
      'high',
    ]);
    expect(handoff.status).toBe(0);
    expect(handoff.stdout).toContain('Created handoff');
  });

  // Both Gap A regression tests need to drive services AND the CLI
  // against the same MEMORIZE_ROOT. The CLI gets it via the spawned
  // subprocess env (always passed through runCli); for service calls
  // inside the test process we have to plant it on process.env so the
  // test process resolves the same bindings file as the subprocess.
  function withSandboxRoot<T>(body: () => Promise<T>): Promise<T> {
    const prev = process.env.MEMORIZE_ROOT;
    process.env.MEMORIZE_ROOT = memorizeRoot;
    return body().finally(() => {
      if (prev === undefined) delete process.env.MEMORIZE_ROOT;
      else process.env.MEMORIZE_ROOT = prev;
    });
  }

  it('handoff CLI attributes to the session-claimed task and actor (Gap A regression at the CLI surface)', { timeout: 30_000 }, async () => {
    await withSandboxRoot(async () => {
    // rc.6 dogfood found that `memorize task handoff` without --task
    // / --from kept falling back to project.activeTaskIds[0] +
    // ACTOR_USER, regardless of which task the calling session had
    // actually claimed at SessionStart. Codex sessions in particular
    // had no way to identify themselves at the CLI surface — every
    // codex handoff was attributed to "user" against the wrong task.
    // The fix threads the cwd session pointer through both fallbacks.
    const project = await createProject({
      title: 'CLI Gap A',
      rootPath: sandbox,
      summary: 'session-aware handoff attribution',
    });
    const taskA = await createTask({
      projectId: project.id,
      title: 'Task A — first in active list',
      actor: 'user',
    });
    const taskB = await createTask({
      projectId: project.id,
      title: 'Task B — what this session actually claimed',
      actor: 'user',
    });
    delete process.env[SESSION_ENV_VAR];
    const sessionId = await startSession(sandbox, {
      projectId: project.id,
      taskId: taskB.id,
      actor: 'codex',
    });
    delete process.env[SESSION_ENV_VAR];

    const startResult = spawnSync(
      'node',
      [tsxCliPath, cliEntryPath, 'task', 'start'],
      {
        cwd: sandbox,
        encoding: 'utf8',
        env: {
          ...process.env,
          MEMORIZE_ROOT: memorizeRoot,
          [SESSION_ENV_VAR]: sessionId,
        },
      },
    );
    expect(startResult.status).toBe(0);

    const handoffResult = spawnSync(
      'node',
      [tsxCliPath, cliEntryPath, 'task', 'handoff',
        '--summary', 'session B work summary',
        '--next', 'next-agent picks up from B'],
      {
        cwd: sandbox,
        encoding: 'utf8',
        env: {
          ...process.env,
          MEMORIZE_ROOT: memorizeRoot,
          [SESSION_ENV_VAR]: sessionId,
        },
      },
    );
    expect(handoffResult.status).toBe(0);
    const handoffIdMatch = handoffResult.stdout.match(/Created handoff (\S+)/);
    expect(handoffIdMatch).not.toBeNull();
    const handoffId = handoffIdMatch![1]!;

    const handoff = await readHandoff(project.id, handoffId);
    // The two assertions that fail in rc.6:
    expect(handoff?.taskId).toBe(taskB.id);    // not taskA.id (the project's first)
    expect(handoff?.fromActor).toBe('codex');  // not 'user' (the historical default)
    void taskA;
    });
  });

  it('checkpoint CLI also honours the session-claimed task (Gap A symmetry)', { timeout: 30_000 }, async () => {
    await withSandboxRoot(async () => {
    const project = await createProject({
      title: 'CLI Gap A checkpoint',
      rootPath: sandbox,
      summary: 'session-aware checkpoint attribution',
    });
    const taskA = await createTask({
      projectId: project.id,
      title: 'Task A — first',
      actor: 'user',
    });
    const taskB = await createTask({
      projectId: project.id,
      title: 'Task B — claimed by this session',
      actor: 'user',
    });
    delete process.env[SESSION_ENV_VAR];
    const sessionId = await startSession(sandbox, {
      projectId: project.id,
      taskId: taskB.id,
      actor: 'codex',
    });
    delete process.env[SESSION_ENV_VAR];

    const checkpointResult = spawnSync(
      'node',
      [tsxCliPath, cliEntryPath, 'task', 'checkpoint',
        '--summary', 'session B mid-flight checkpoint'],
      {
        cwd: sandbox,
        encoding: 'utf8',
        env: {
          ...process.env,
          MEMORIZE_ROOT: memorizeRoot,
          [SESSION_ENV_VAR]: sessionId,
        },
      },
    );
    expect(checkpointResult.status).toBe(0);

    // Read the project's tasks; taskB.latestCheckpointId must be set,
    // taskA.latestCheckpointId must NOT be set. Cleaner contract than
    // grepping the events file: validates the projection too.
    const taskBAfter = await readTask(project.id, taskB.id);
    const taskAAfter = await readTask(project.id, taskA.id);
    expect(taskBAfter?.latestCheckpointId).toBeDefined();
    expect(taskAAfter?.latestCheckpointId).toBeUndefined();
    });
  });

  it('marks a handoff_ready task done via cli', { timeout: 30_000 }, async () => {
    await withSandboxRoot(async () => {
      const project = await createProject({
        title: 'Done flow',
        rootPath: sandbox,
        summary: 'task done CLI verb',
      });
      const task = await createTask({
        projectId: project.id,
        title: 'Task to complete',
        actor: 'user',
      });
      delete process.env[SESSION_ENV_VAR];
      const sessionId = await startSession(sandbox, {
        projectId: project.id,
        taskId: task.id,
        actor: 'codex',
      });
      delete process.env[SESSION_ENV_VAR];

      function runSessionCli(args: string[]): ReturnType<typeof spawnSync> {
        return spawnSync('node', [tsxCliPath, cliEntryPath, ...args], {
          cwd: sandbox,
          encoding: 'utf8',
          env: {
            ...process.env,
            MEMORIZE_ROOT: memorizeRoot,
            [SESSION_ENV_VAR]: sessionId,
          },
        });
      }

      expect(runSessionCli(['task', 'start']).status).toBe(0);

      const handoff = runSessionCli([
        'task',
        'handoff',
        '--summary',
        'Ready to finish',
        '--next',
        'mark done',
      ]);
      expect(handoff.status).toBe(0);

      const done = runSessionCli(['task', 'done']);
      expect(done.status).toBe(0);
      expect(done.stdout).toContain('marked done');

      const storedTask = await readTask(project.id, task.id);
      expect(storedTask?.status).toBe('done');
    });
  });

  it('rejects task done on a task that is not handoff_ready', { timeout: 30_000 }, () => {
    runCli(['project', 'init']);
    runCli(['task', 'create', 'Fresh todo task']);

    const done = runCli(['task', 'done']);
    expect(done.status).not.toBe(0);
    expect(done.stderr).toContain('Invalid task status transition');
  });

  it('rejects task handoff when required flags are missing', () => {
    runCli(['project', 'init']);
    runCli(['task', 'create', 'Missing flags test']);

    const missingNext = runCli([
      'task',
      'handoff',
      '--summary',
      'no next action',
    ]);
    expect(missingNext.status).not.toBe(0);
    expect(missingNext.stderr).toContain('--next is required');
  });

  it('creates a project-scoped sync metadata file during initialization', async () => {
    const project = await createProject({
      title: 'Memorize',
      rootPath: sandbox,
      summary: 'Shared context system',
    });

    const syncState = await readJson<ProjectSyncState>(getSyncFile(project.id));
    expect(syncState?.projectId).toBe(project.id);
    expect(syncState?.syncEnabled).toBe(false);
    expect(syncState?.syncStatus).toBe('idle');
  });

  it('accepts literal values that start with dashes and --flag=value syntax', { timeout: 30_000 }, () => {
    expect(runCli(['project', 'init']).status).toBe(0);
    expect(runCli(['task', 'create', 'Parser edge task']).status).toBe(0);

    const dashSummary = runCli([
      'task',
      'checkpoint',
      '--summary',
      '--force path needed for legacy tool',
    ]);
    expect(dashSummary.status).toBe(0);
    expect(dashSummary.stdout).toContain('Created checkpoint');

    const equalsForm = runCli([
      'task',
      'checkpoint',
      '--summary=equals-form works too',
    ]);
    expect(equalsForm.status).toBe(0);
    expect(equalsForm.stdout).toContain('Created checkpoint');

    const missingValue = runCli([
      'task',
      'checkpoint',
      '--summary',
      '--session',
      'abc',
    ]);
    expect(missingValue.status).not.toBe(0);
    expect(missingValue.stderr).toContain('--summary requires a value');
  });

  it('lists tasks with optional status filter', { timeout: 30_000 }, () => {
    expect(runCli(['project', 'init']).status).toBe(0);
    expect(runCli(['task', 'create', 'Alpha task']).status).toBe(0);
    expect(runCli(['task', 'create', 'Beta task']).status).toBe(0);

    const listAll = runCli(['task', 'list']);
    expect(listAll.status).toBe(0);
    expect(listAll.stdout).toContain('Alpha task');
    expect(listAll.stdout).toContain('Beta task');
    expect(listAll.stdout).toContain('todo');

    const listTodo = runCli(['task', 'list', '--status', 'todo']);
    expect(listTodo.status).toBe(0);
    expect(listTodo.stdout).toContain('Alpha task');

    const listDone = runCli(['task', 'list', '--status', 'done']);
    expect(listDone.status).toBe(0);
    expect(listDone.stdout).toContain('No tasks found');

    const invalid = runCli(['task', 'list', '--status', 'unknown']);
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain('--status must be one of');
  });

  it('rejects checkpoint when --summary is missing', () => {
    runCli(['project', 'init']);
    runCli(['task', 'create', 'Summary test']);

    const result = runCli(['task', 'checkpoint']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--summary is required');
  });

  it('rejects handoff with invalid --confidence value', () => {
    runCli(['project', 'init']);
    runCli(['task', 'create', 'Confidence test']);

    const result = runCli([
      'task',
      'handoff',
      '--summary',
      'test',
      '--next',
      'verify',
      '--confidence',
      'medium-high',
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--confidence must be one of');
  });

  // Bug #120 — conflicts modeled with a `detected -> resolved` transition but
  // no producer ever emitted `conflict.resolved`, so they were stuck open.
  async function seedDetectedConflict(projectId: string): Promise<string> {
    const conflict = createConflict({
      projectId,
      scopeType: 'decision',
      scopeId: 'dec_seed',
      fieldPath: 'topic',
      leftVersion: 'left',
      rightVersion: 'right',
      conflictType: 'decision',
    });
    await appendEvent({
      type: 'conflict.detected',
      projectId,
      scopeType: 'project',
      scopeId: conflict.id,
      actor: 'system',
      payload: conflict,
    });
    await rebuildProjectProjection(projectId);
    return conflict.id;
  }

  it('resolves a detected conflict via the service producer', async () => {
    const project = await createProject({ title: 'Conflict flow', rootPath: sandbox });
    const conflictId = await seedDetectedConflict(project.id);

    expect((await loadStartContext({ projectId: project.id })).openConflicts).toHaveLength(1);

    await resolveConflict(project.id, conflictId, {
      actor: 'user',
      summary: 'picked the right version',
    });

    const stored = getConflict(project.id, conflictId);
    expect(stored?.status).toBe('resolved');
    expect(stored?.resolvedBy).toBe('user');
    expect(stored?.resolutionSummary).toBe('picked the right version');
    // Projector must move it out of the open set (WHERE status != 'resolved').
    expect((await loadStartContext({ projectId: project.id })).openConflicts).toHaveLength(0);
  });

  it('rejects resolving a conflict that is already resolved', async () => {
    const project = await createProject({ title: 'Conflict guard', rootPath: sandbox });
    const conflictId = await seedDetectedConflict(project.id);
    await resolveConflict(project.id, conflictId, { actor: 'user' });

    await expect(
      resolveConflict(project.id, conflictId, { actor: 'user' }),
    ).rejects.toThrow(/Invalid conflict status transition/);
  });

  it('resolves a conflict via cli and clears it from the open set', { timeout: 30_000 }, async () => {
    // Bind cwd via the CLI so the spawned subprocess and the in-process
    // seeding below share one project id.
    const init = runCli(['project', 'init']);
    expect(init.status).toBe(0);
    const boundProjectId = (await getBoundProjectId(sandbox))!;
    const conflictId = await seedDetectedConflict(boundProjectId);

    const before = runCli(['conflict']);
    expect(before.stdout).toContain(conflictId);

    const resolve = runCli(['conflict', 'resolve', conflictId, '--summary', 'done']);
    expect(resolve.status).toBe(0);
    expect(resolve.stdout).toContain('resolved');

    const after = runCli(['conflict']);
    expect(after.stdout).not.toContain(conflictId);
  });

  // Bug #121 — decision.proposed/accepted modeled + projected but no producer.
  it('records a decision via the service producer', async () => {
    const project = await createProject({ title: 'Decision flow', rootPath: sandbox });

    const decision = await recordDecision({
      projectId: project.id,
      title: 'Use SQLite',
      decision: 'Adopt better-sqlite3 for the projection store',
      rationale: 'Synchronous, embedded, zero-config',
      actor: 'user',
    });

    expect(decision.status).toBe('accepted');
    const refreshed = await readProject(project.id);
    expect(refreshed?.acceptedDecisionIds).toContain(decision.id);
  });

  it('records a decision via cli', { timeout: 30_000 }, async () => {
    expect(runCli(['project', 'init']).status).toBe(0);

    const add = runCli([
      'project',
      'decision',
      'add',
      '--title',
      'Use SQLite',
      '--decision',
      'Adopt better-sqlite3',
      '--rationale',
      'Synchronous embedded store',
    ]);
    expect(add.status).toBe(0);
    expect(add.stdout).toContain('Recorded decision');

    const show = runCli(['project', 'show']);
    expect(show.status).toBe(0);
    expect(show.stdout).toContain('acceptedDecisionIds');
    const parsed = JSON.parse(String(show.stdout)) as {
      acceptedDecisionIds: string[];
    };
    expect(parsed.acceptedDecisionIds.length).toBe(1);
  });

});
