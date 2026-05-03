import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadStartContext } from '../../src/services/context-service.js';
import { createProject } from '../../src/services/project-service.js';
import {
  SESSION_ENV_VAR,
  startSession,
} from '../../src/services/session-service.js';
import { createTask } from '../../src/services/task-service.js';

let sandbox: string;
let memorizeRoot: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-picker-'));
  memorizeRoot = join(sandbox, '.memorize-home');
  process.env.MEMORIZE_ROOT = memorizeRoot;
  delete process.env[SESSION_ENV_VAR];
});

afterEach(async () => {
  delete process.env.MEMORIZE_ROOT;
  delete process.env[SESSION_ENV_VAR];
  await rm(sandbox, { recursive: true, force: true });
});

// rc.2 dogfood found the auto-picker always returning the same first
// candidate task even when other active sessions had clearly claimed
// it. These tests pin the deconflict behavior end-to-end so any future
// regression to the old "first-of-list" picker fails loudly.
describe('loadStartContext picker — task deconfliction', () => {
  it('skips tasks already claimed by other active sessions and picks the first unclaimed one', async () => {
    const project = await createProject({
      title: 'duo-pane',
      rootPath: sandbox,
      summary: 'test',
    });
    const t1 = await createTask({ projectId: project.id, title: 'Task 1', actor: 'user' });
    const t2 = await createTask({ projectId: project.id, title: 'Task 2', actor: 'user' });
    const t3 = await createTask({ projectId: project.id, title: 'Task 3', actor: 'user' });

    // Session A starts and claims t1.
    delete process.env[SESSION_ENV_VAR];
    await startSession(sandbox, {
      projectId: project.id,
      taskId: t1.id,
      actor: 'claude',
    });

    // New context load (without explicit taskId, simulating session B
    // starting fresh): picker must skip t1 and return t2.
    const startup = await loadStartContext({ projectId: project.id });
    expect(startup.task?.id).toBe(t2.id);
    void t3;
  });

  it('falls back to a claimed task only when every candidate is claimed', async () => {
    const project = await createProject({
      title: 'full-house',
      rootPath: sandbox,
      summary: 'test',
    });
    const t1 = await createTask({ projectId: project.id, title: 'Task 1', actor: 'user' });
    const t2 = await createTask({ projectId: project.id, title: 'Task 2', actor: 'user' });

    delete process.env[SESSION_ENV_VAR];
    await startSession(sandbox, {
      projectId: project.id,
      taskId: t1.id,
      actor: 'claude',
    });
    delete process.env[SESSION_ENV_VAR];
    await startSession(sandbox, {
      projectId: project.id,
      taskId: t2.id,
      actor: 'codex',
    });

    // No unclaimed candidates left — picker still returns something so
    // the agent has a starting point. The renderer surfaces
    // otherActiveTasks alongside, so the agent knows it is duplicating
    // work and can decide to defer.
    const startup = await loadStartContext({ projectId: project.id });
    expect(startup.task).toBeDefined();
    expect([t1.id, t2.id]).toContain(startup.task?.id);
    expect(startup.otherActiveTasks?.length).toBeGreaterThan(0);
  });

  it('does not exclude the calling session itself when selfSessionId is passed', async () => {
    const project = await createProject({
      title: 'self-aware',
      rootPath: sandbox,
      summary: 'test',
    });
    const t1 = await createTask({ projectId: project.id, title: 'Task 1', actor: 'user' });
    await createTask({ projectId: project.id, title: 'Task 2', actor: 'user' });

    delete process.env[SESSION_ENV_VAR];
    const selfSessionId = await startSession(sandbox, {
      projectId: project.id,
      taskId: t1.id,
      actor: 'claude',
    });

    // Self-claim on t1 must not block the picker from offering t1
    // back when the caller IS that session — e.g. session resumes
    // mid-flow after a compact and re-loads its own context.
    const startup = await loadStartContext({
      projectId: project.id,
      selfSessionId,
    });
    expect(startup.task?.id).toBe(t1.id);
  });
});
