import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFileSyncTransport } from '../../src/adapters/sync-transport-file.js';
import type { DomainEvent } from '../../src/domain/events.js';
import {
  bumpHeartbeat,
  startSession,
} from '../../src/services/session-service.js';
import { setupProject } from '../../src/services/setup-service.js';
import {
  createCheckpoint,
  createHandoff,
  createTask,
} from '../../src/services/task-service.js';
import {
  cloneProject,
  pullProject,
  pushProject,
} from '../../src/services/sync-service.js';
import { closeAll } from '../../src/storage/db.js';
import { readEvents } from '../../src/storage/event-store.js';
import { readNdjson } from '../../src/storage/fs-utils.js';
import { getBoundProjectId } from '../../src/services/project-service.js';

let sandbox: string;

async function makeProject(name: string): Promise<string> {
  const projectDir = join(sandbox, name);
  await mkdir(projectDir, { recursive: true });
  return projectDir;
}

async function withMemorizeRoot<T>(
  root: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = process.env.MEMORIZE_ROOT;
  process.env.MEMORIZE_ROOT = root;
  // A true replica shares the SAME projectId across "machines"; getDb caches
  // by projectId, so drop the cache on entry to bind to THIS root's DB. Real
  // separate processes start with an empty cache anyway.
  closeAll();
  try {
    return await fn();
  } finally {
    closeAll();
    if (previous === undefined) {
      delete process.env.MEMORIZE_ROOT;
    } else {
      process.env.MEMORIZE_ROOT = previous;
    }
  }
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-sync-golden-'));
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('sync golden — true-replica baseline', () => {
  it('roundtrips every supported event type from A to a clone B', async () => {
    const remotePath = join(sandbox, 'remote');
    const homeA = join(sandbox, 'home-a');
    const homeB = join(sandbox, 'home-b');
    const transport = createFileSyncTransport(remotePath);

    // ---- Project A: produce one event per type the projector handles ----
    const projectIdA = await withMemorizeRoot(homeA, async () => {
      const projectDirA = await makeProject('a');
      await writeFile(
        join(projectDirA, 'AGENTS.md'),
        '# A\nUse small commits.\n',
        'utf8',
      );
      const setup = await setupProject(projectDirA);
      const projectId = setup.project.id;

      const task = await createTask({
        projectId,
        title: 'Sync golden task',
        actor: 'user',
      });
      await createCheckpoint({
        projectId,
        taskId: task.id,
        sessionId: 'session_test_a',
        summary: 'Mid-session snapshot for golden test',
      });
      await createHandoff({
        projectId,
        taskId: task.id,
        fromActor: 'claude',
        toActor: 'codex',
        summary: 'Handed off after golden checkpoint',
        nextAction: 'Pull on B and verify',
      });
      await startSession(projectDirA, {
        actor: 'claude',
        projectId,
        taskId: task.id,
      });
      await bumpHeartbeat(projectDirA);

      const pushResponse = await pushProject(projectId, transport);
      expect(pushResponse.accepted.length).toBeGreaterThan(0);

      return projectId;
    });

    // ---- Project B: CLONE A (adopt its id) and verify all types arrived ----
    await withMemorizeRoot(homeB, async () => {
      const projectDirB = await makeProject('b');
      const clone = await cloneProject(projectDirB, projectIdA, transport);
      expect(clone.projectId).toBe(projectIdA);
      expect(clone.pulled).toBeGreaterThan(0);

      // B's log IS the replica of A (same projectId).
      const allEvents = await readEvents(projectIdA);
      const types = new Set(allEvents.map((event) => event.type));
      expect(types).toContain('project.created');
      expect(types).toContain('workstream.created');
      expect(types).toContain('rule.upserted');
      expect(types).toContain('task.created');
      expect(types).toContain('checkpoint.created');
      expect(types).toContain('handoff.created');
      // Assignment-model events cross the wire (lock-free assignment design).
      expect(types).toContain('session.started');
      expect(types).toContain('session.heartbeat');
      // Exactly one identity (the #30 invariant).
      expect(
        allEvents.filter((e) => e.type === 'project.created'),
      ).toHaveLength(1);

      // sync.state.updated is local bookkeeping and MUST NOT cross the wire:
      // assert it on the remote file (the actual wire), since post-clone B's
      // own watermark-bump sync.state.updated lives in its local log.
      const wire = await readNdjson<DomainEvent>(
        join(remotePath, projectIdA, 'events.ndjson'),
      );
      expect(wire.some((e) => e.type === 'sync.state.updated')).toBe(false);

      // Payload integrity — handoff content survived.
      const handoffEvent = allEvents.find((e) => e.type === 'handoff.created');
      const handoffPayload = handoffEvent?.payload as {
        summary: string;
        nextAction: string;
        fromActor: string;
        toActor: string;
      };
      expect(handoffPayload.summary).toBe('Handed off after golden checkpoint');
      expect(handoffPayload.nextAction).toBe('Pull on B and verify');
      expect(handoffPayload.fromActor).toBe('claude');
      expect(handoffPayload.toActor).toBe('codex');
    });
  });

  it('supports bidirectional sync — a clone B can push events back to A', async () => {
    const remotePath = join(sandbox, 'remote');
    const homeA = join(sandbox, 'home-a');
    const homeB = join(sandbox, 'home-b');
    const transport = createFileSyncTransport(remotePath);

    // A: create + push
    const { projectIdA, projectDirA } = await withMemorizeRoot(homeA, async () => {
      const dir = await makeProject('a');
      const setup = await setupProject(dir);
      await createTask({
        projectId: setup.project.id,
        title: 'A original task',
        actor: 'user',
      });
      await pushProject(setup.project.id, transport);
      return { projectIdA: setup.project.id, projectDirA: dir };
    });

    // B: clone (adopt A's id), add a new task, push back.
    await withMemorizeRoot(homeB, async () => {
      const projectDirB = await makeProject('b');
      const clone = await cloneProject(projectDirB, projectIdA, transport);
      expect(clone.pulled).toBeGreaterThan(0);

      await createTask({
        projectId: projectIdA, // replica: same id everywhere
        title: 'B added this task',
        actor: 'user',
      });
      await pushProject(projectIdA, transport);
    });

    // A: pull and confirm B's task arrived.
    await withMemorizeRoot(homeA, async () => {
      expect(await getBoundProjectId(projectDirA)).toBe(projectIdA);
      const pullResult = await pullProject(projectIdA, transport);
      expect(pullResult.total).toBeGreaterThan(0);

      const titles = (await readEvents(projectIdA))
        .filter((event) => event.type === 'task.created')
        .map((event) => (event.payload as { title: string }).title);
      expect(titles).toContain('A original task');
      expect(titles).toContain('B added this task');
      // Round-trip preserved a single identity.
      expect(
        (await readEvents(projectIdA)).filter(
          (e) => e.type === 'project.created',
        ),
      ).toHaveLength(1);
    });
  });
});
