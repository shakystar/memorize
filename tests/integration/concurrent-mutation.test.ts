import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProject } from '../../src/services/project-service.js';
import { createTask, updateTask } from '../../src/services/task-service.js';
import { readEvents } from '../../src/storage/event-store.js';
import {
  SESSION_ENV_VAR,
  startSession,
} from '../../src/services/session-service.js';
import { reduceProjectState } from '../../src/projections/projector.js';

let sandbox: string;
let memorizeRoot: string;

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), 'memorize-concurrent-')));
  memorizeRoot = join(sandbox, '.memorize-home');
  process.env.MEMORIZE_ROOT = memorizeRoot;
  delete process.env[SESSION_ENV_VAR];
});

afterEach(async () => {
  delete process.env.MEMORIZE_ROOT;
  delete process.env[SESSION_ENV_VAR];
  await rm(sandbox, { recursive: true, force: true });
});

describe('concurrent mutation safety', () => {
  // ─── 2-1: concurrent task status transitions ─────────────────

  describe('concurrent task status transitions', () => {
    it('both agents can transition the same task to in_progress (last-write-wins via append-only log)', async () => {
      // Memorize uses append-only event sourcing: both transitions
      // succeed at the event level because each reads the current
      // state, validates, then appends. This test pins that neither
      // call crashes and the final projection is consistent.
      const project = await createProject({
        title: 'race-status',
        rootPath: sandbox,
        summary: 'concurrent mutation test',
      });
      const task = await createTask({
        projectId: project.id,
        title: 'Shared task',
        actor: 'user',
      });

      // Both agents transition todo → in_progress concurrently
      const results = await Promise.allSettled([
        updateTask(project.id, task.id, { status: 'in_progress' }, 'claude'),
        updateTask(project.id, task.id, { status: 'in_progress' }, 'codex'),
      ]);

      // Both should succeed (append-only semantics — no compare-and-swap)
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled.length).toBe(2);

      // The event log should contain both task.updated events
      const events = await readEvents(project.id);
      const statusUpdates = events.filter(
        (e) =>
          e.type === 'task.updated' &&
          e.scopeId === task.id &&
          (e.payload as Record<string, unknown>).status === 'in_progress',
      );
      expect(statusUpdates.length).toBe(2);

      // Distinct actors recorded
      const actors = new Set(statusUpdates.map((e) => e.actor));
      expect(actors).toEqual(new Set(['claude', 'codex']));
    });

    it('rejects invalid transitions even under concurrency', async () => {
      const project = await createProject({
        title: 'race-invalid',
        rootPath: sandbox,
        summary: 'test',
      });
      const task = await createTask({
        projectId: project.id,
        title: 'Guarded task',
        actor: 'user',
      });

      // One valid (todo → in_progress), one invalid (todo → done)
      const results = await Promise.allSettled([
        updateTask(project.id, task.id, { status: 'in_progress' }, 'claude'),
        updateTask(project.id, task.id, { status: 'done' }, 'codex'),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // At least the invalid transition should fail
      expect(rejected.length).toBeGreaterThanOrEqual(1);
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);

      // The rejected reason should mention invalid transition
      for (const r of rejected) {
        expect((r as PromiseRejectedResult).reason.message).toMatch(
          /invalid.*transition/i,
        );
      }
    });
  });

  // ─── 2-2: concurrent event appends → projection consistency ──

  describe('concurrent event appends → projection consistency', () => {
    it('produces consistent projection after parallel task creation', async () => {
      const project = await createProject({
        title: 'parallel-tasks',
        rootPath: sandbox,
        summary: 'consistency test',
      });

      const count = 10;
      const tasks = await Promise.all(
        Array.from({ length: count }, (_, i) =>
          createTask({
            projectId: project.id,
            title: `parallel-task-${i}`,
            actor: 'user',
          }),
        ),
      );

      // All tasks should have been created with unique IDs
      const ids = new Set(tasks.map((t) => t.id));
      expect(ids.size).toBe(count);

      // Event log should have all task.created events
      const events = await readEvents(project.id);
      const taskCreated = events.filter((e) => e.type === 'task.created');
      expect(taskCreated.length).toBe(count);

      // Rebuild projection from scratch and verify consistency
      const allEvents = await readEvents(project.id);
      const state = reduceProjectState(allEvents);
      const taskEntries = Object.values(state.tasks);
      expect(taskEntries.length).toBe(count);

      // All task titles should be unique and present
      const titles = taskEntries.map((t) => t.title);
      for (let i = 0; i < count; i++) {
        expect(titles).toContain(`parallel-task-${i}`);
      }
    });

    it('NDJSON integrity holds after concurrent mixed operations', async () => {
      const project = await createProject({
        title: 'mixed-ops',
        rootPath: sandbox,
        summary: 'mixed concurrency test',
      });

      // Create 5 tasks sequentially first
      const tasks = [];
      for (let i = 0; i < 5; i++) {
        tasks.push(
          await createTask({
            projectId: project.id,
            title: `task-${i}`,
            actor: 'user',
          }),
        );
      }

      // Now do mixed concurrent operations: create 5 more + update 5 existing
      await Promise.all([
        // 5 new creates
        ...Array.from({ length: 5 }, (_, i) =>
          createTask({
            projectId: project.id,
            title: `concurrent-task-${i}`,
            actor: 'user',
          }),
        ),
        // 5 status updates on existing tasks
        ...tasks.map((t) =>
          updateTask(project.id, t.id, { status: 'in_progress' }, 'claude'),
        ),
      ]);

      // Read events and check no corruption
      const { events, corruptLines } = await (
        await import('../../src/storage/event-store.js')
      ).readEventsWithIntegrity(project.id);

      expect(corruptLines).toEqual([]);
      // 1 project.created + 5 initial task.created + 5 concurrent task.created
      // + 5 task.updated + N projection rebuilds (not events)
      const taskEvents = events.filter(
        (e) => e.type === 'task.created' || e.type === 'task.updated',
      );
      expect(taskEvents.length).toBe(15); // 10 created + 5 updated
    });
  });

  // ─── 2-extra: concurrent session starts claim distinct tasks ──

  describe('concurrent session + task lifecycle', () => {
    it('concurrent sessions with status transitions maintain valid event ordering', async () => {
      const project = await createProject({
        title: 'lifecycle-race',
        rootPath: sandbox,
        summary: 'lifecycle test',
      });

      const t1 = await createTask({
        projectId: project.id,
        title: 'Task A',
        actor: 'user',
      });
      const t2 = await createTask({
        projectId: project.id,
        title: 'Task B',
        actor: 'user',
      });

      // Start two sessions claiming different tasks
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

      // Both update their own tasks concurrently
      await Promise.all([
        updateTask(project.id, t1.id, { status: 'in_progress' }, 'claude'),
        updateTask(project.id, t2.id, { status: 'in_progress' }, 'codex'),
      ]);

      // Events should be temporally ordered (createdAt non-decreasing)
      const events = await readEvents(project.id);
      for (let i = 1; i < events.length; i++) {
        expect(events[i]!.createdAt >= events[i - 1]!.createdAt).toBe(true);
      }

      // Each task should have exactly one status update
      const t1Updates = events.filter(
        (e) => e.type === 'task.updated' && e.scopeId === t1.id,
      );
      const t2Updates = events.filter(
        (e) => e.type === 'task.updated' && e.scopeId === t2.id,
      );
      expect(t1Updates.length).toBe(1);
      expect(t2Updates.length).toBe(1);
      expect(t1Updates[0]!.actor).toBe('claude');
      expect(t2Updates[0]!.actor).toBe('codex');
    });
  });
});
