import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProject } from '../../src/services/project-service.js';
import {
  createTask,
  readTask,
  updateTask,
} from '../../src/services/task-service.js';
import { getProjectProjection } from '../../src/services/projection-store.js';
import { readEvents } from '../../src/storage/event-store.js';
import { closeAll } from '../../src/storage/db.js';

let sandbox: string;
let memorizeRoot: string;

const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

function runCli(args: string[]) {
  return spawnSync(process.execPath, [tsxCliPath, cliEntryPath, ...args], {
    cwd: sandbox,
    encoding: 'utf8',
    env: { ...process.env, MEMORIZE_ROOT: memorizeRoot },
  });
}

async function seedTask(): Promise<{ projectId: string; taskId: string }> {
  const project = await createProject({
    title: 'Correction project',
    rootPath: sandbox,
  });
  const task = await createTask({
    projectId: project.id,
    title: 'Original title',
    actor: 'user',
  });
  return { projectId: project.id, taskId: task.id };
}

beforeEach(async () => {
  // macOS os.tmpdir() is a symlink (/var -> /private/var); canonicalize so the
  // path we bind in-process matches the realpath the spawned CLI sees as cwd.
  sandbox = await realpath(await mkdtemp(join(tmpdir(), 'memorize-task-correction-')));
  memorizeRoot = join(sandbox, '.memorize-home');
  process.env.MEMORIZE_ROOT = memorizeRoot;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('memorize task update (append-only correction)', () => {
  it('appends task.updated with the new title/description; original task.created survives', async () => {
    const { projectId, taskId } = await seedTask();
    const before = await readEvents(projectId);
    const createdCountBefore = before.filter(
      (e) => e.type === 'task.created',
    ).length;
    expect(createdCountBefore).toBe(1);

    const result = runCli([
      'task',
      'update',
      taskId,
      '--title',
      'New title',
      '--note',
      'New note',
    ]);
    expect(result.status).toBe(0);

    const task = await readTask(projectId, taskId);
    expect(task?.title).toBe('New title');
    expect(task?.description).toBe('New note');

    const after = await readEvents(projectId);
    // Append-only: created is still present, an updated event was added.
    expect(after.filter((e) => e.type === 'task.created').length).toBe(1);
    expect(after.filter((e) => e.type === 'task.updated').length).toBe(1);
    expect(after.length).toBe(before.length + 1);
  });

  it('rejects update with no flags at all', async () => {
    const { taskId } = await seedTask();
    const result = runCli(['task', 'update', taskId]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--title|--note|--question|--risk|--ac/i);
  });

  it('appends one task.item-appended event per --question/--risk/--ac item', async () => {
    const { projectId, taskId } = await seedTask();
    const before = await readEvents(projectId);

    const result = runCli([
      'task',
      'update',
      taskId,
      '--question',
      'Which lane wins on conflict?',
      '--question',
      'Is the Hub filter server-side?',
      '--risk',
      'Blocked on upstream API key',
      '--ac',
      'Panel renders questions',
    ]);
    expect(result.status).toBe(0);

    const task = await readTask(projectId, taskId);
    expect(task?.openQuestions).toEqual([
      'Which lane wins on conflict?',
      'Is the Hub filter server-side?',
    ]);
    expect(task?.riskNotes).toEqual(['Blocked on upstream API key']);
    expect(task?.acceptanceCriteria).toEqual(['Panel renders questions']);

    const after = await readEvents(projectId);
    // One event per item, no task.updated (no --title/--note given).
    expect(after.filter((e) => e.type === 'task.item-appended').length).toBe(4);
    expect(after.filter((e) => e.type === 'task.updated').length).toBe(0);
    expect(after.length).toBe(before.length + 4);
  });

  it('rejects blank items instead of appending filled-looking empty rows', async () => {
    const { projectId, taskId } = await seedTask();
    const result = runCli(['task', 'update', taskId, '--question', '  ']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/task\.openQuestions items must be non-empty/i);

    const task = await readTask(projectId, taskId);
    expect(task?.openQuestions).toEqual([]);
  });

  it('appends items across two updates without clobbering earlier ones', async () => {
    const { projectId, taskId } = await seedTask();
    expect(
      runCli(['task', 'update', taskId, '--risk', 'first risk']).status,
    ).toBe(0);
    expect(
      runCli(['task', 'update', taskId, '--risk', 'second risk']).status,
    ).toBe(0);

    const task = await readTask(projectId, taskId);
    expect(task?.riskNotes).toEqual(['first risk', 'second risk']);
  });
});

describe('memorize task create (field flags)', () => {
  it('creates a task with goal/priority/AC and leaves description/goal empty when omitted', async () => {
    const { projectId } = await seedTask();

    const rich = runCli([
      'task',
      'create',
      'Rich task',
      '--goal',
      'Prove the flags fill the projection',
      '--priority',
      'high',
      '--ac',
      'goal lands in projection',
      '--ac',
      'priority is non-default',
    ]);
    expect(rich.status).toBe(0);
    const richId = rich.stdout.match(/Created task (\S+)/)?.[1];
    expect(richId).toBeTruthy();
    const richTask = await readTask(projectId, richId ?? '');
    expect(richTask?.goal).toBe('Prove the flags fill the projection');
    expect(richTask?.priority).toBe('high');
    expect(richTask?.acceptanceCriteria).toEqual([
      'goal lands in projection',
      'priority is non-default',
    ]);

    const bare = runCli(['task', 'create', 'Bare task']);
    expect(bare.status).toBe(0);
    const bareId = bare.stdout.match(/Created task (\S+)/)?.[1];
    const bareTask = await readTask(projectId, bareId ?? '');
    // No title fallback: empty means empty, not a copy of the title.
    expect(bareTask?.description).toBe('');
    expect(bareTask?.goal).toBe('');
  });

  it('rejects unknown flags instead of joining them into the title', async () => {
    const { projectId } = await seedTask();
    const result = runCli([
      'task',
      'create',
      'Fix the thing',
      '--proirity',
      'high',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unknown flag --proirity/i);

    const events = await readEvents(projectId);
    const titles = events
      .filter((e) => e.type === 'task.created')
      .map((e) => (e.payload as { title: string }).title);
    expect(titles).not.toContain('Fix the thing --proirity high');
  });

  it('rejects an out-of-range --priority', async () => {
    await seedTask();
    const result = runCli(['task', 'create', 'Bad priority', '--priority', 'urgent']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--priority must be one of low\|medium\|high/i);
  });
});

describe('memorize task cancel (append-only tombstone)', () => {
  it('moves the task to cancelled, drops it from activeTaskIds, and appends an event', async () => {
    const { projectId, taskId } = await seedTask();
    const before = await readEvents(projectId);

    const result = runCli(['task', 'cancel', taskId]);
    expect(result.status).toBe(0);

    const task = await readTask(projectId, taskId);
    expect(task?.status).toBe('cancelled');

    const project = getProjectProjection(projectId);
    expect(project?.activeTaskIds).not.toContain(taskId);

    const after = await readEvents(projectId);
    // Append-only: nothing deleted, exactly one event appended.
    expect(after.length).toBe(before.length + 1);
    expect(after.filter((e) => e.type === 'task.created').length).toBe(1);
  });

  it('refuses to cancel a done task (done is terminal success)', async () => {
    const { projectId, taskId } = await seedTask();
    // Drive to done via the legal path.
    expect(runCli(['task', 'update', taskId, '--title', 'x']).status).toBe(0);
    // status path: todo -> in_progress -> handoff_ready -> done
    await updateTask(projectId, taskId, { status: 'in_progress' }, 'user');
    await updateTask(projectId, taskId, { status: 'handoff_ready' }, 'user');
    await updateTask(projectId, taskId, { status: 'done' }, 'user');

    const result = runCli(['task', 'cancel', taskId]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/invalid task status transition|done -> cancelled/i);
  });
});

describe('memorize task done / handoff (honor positional taskId)', () => {
  // The first-created non-terminal task is project.activeTaskIds[0], the
  // fallback a session-less CLI resolves to. `target` is created second so it
  // is NEVER the fallback — proving the positional id, not the fallback, wins.
  async function seedActiveAndTarget(): Promise<{
    projectId: string;
    activeId: string;
    targetId: string;
  }> {
    const project = await createProject({
      title: 'Lifecycle project',
      rootPath: sandbox,
    });
    const active = await createTask({
      projectId: project.id,
      title: 'Session-active fallback task',
      actor: 'user',
    });
    const target = await createTask({
      projectId: project.id,
      title: 'Explicit positional target',
      actor: 'user',
    });
    return { projectId: project.id, activeId: active.id, targetId: target.id };
  }

  it('applies `task done <id>` to the positional task, not the active fallback', async () => {
    const { projectId, activeId, targetId } = await seedActiveAndTarget();
    // done is only legal from handoff_ready; drive both there.
    for (const id of [activeId, targetId]) {
      await updateTask(projectId, id, { status: 'in_progress' }, 'user');
      await updateTask(projectId, id, { status: 'handoff_ready' }, 'user');
    }

    const result = runCli(['task', 'done', targetId]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(targetId);

    expect((await readTask(projectId, targetId))?.status).toBe('done');
    // The activeTaskIds[0] fallback must be left untouched.
    expect((await readTask(projectId, activeId))?.status).toBe('handoff_ready');
  });

  it('applies `task handoff <id>` to the positional task, not the active fallback', async () => {
    const { projectId, activeId, targetId } = await seedActiveAndTarget();
    for (const id of [activeId, targetId]) {
      await updateTask(projectId, id, { status: 'in_progress' }, 'user');
    }

    const result = runCli([
      'task',
      'handoff',
      targetId,
      '--summary',
      'did the thing',
      '--next',
      'review it',
    ]);
    expect(result.status).toBe(0);

    expect((await readTask(projectId, targetId))?.status).toBe('handoff_ready');
    // The fallback must remain in_progress, not be handed off in its place.
    expect((await readTask(projectId, activeId))?.status).toBe('in_progress');
  });
});
