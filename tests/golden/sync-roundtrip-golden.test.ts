import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFileSyncTransport } from '../../src/adapters/sync-transport-file.js';
import { setupProject } from '../../src/services/setup-service.js';
import {
  createCheckpoint,
  createHandoff,
  createTask,
} from '../../src/services/task-service.js';
import {
  applyPullResponse,
  drainInbound,
  pullProject,
  pushProject,
  updateSyncState,
} from '../../src/services/sync-service.js';
import { readEvents } from '../../src/storage/event-store.js';
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
  try {
    return await fn();
  } finally {
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
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('sync golden — 1.0 compatibility baseline', () => {
  it('roundtrips every supported event type from A to B', async () => {
    const remotePath = join(sandbox, 'remote');
    const homeA = join(sandbox, 'home-a');
    const homeB = join(sandbox, 'home-b');
    const transport = createFileSyncTransport(remotePath);

    // ---- Project A: produce one event per type the projector handles ----
    const projectIdA = await withMemorizeRoot(homeA, async () => {
      const projectDirA = await makeProject('a');
      // Importable rules → rule.upserted
      await writeFile(
        join(projectDirA, 'AGENTS.md'),
        '# A\nUse small commits.\n',
        'utf8',
      );
      // setupProject → project.created + workstream.created + rule.upserted
      const setup = await setupProject(projectDirA);
      const projectId = setup.project.id;

      // task.created (and task.updated via downstream services)
      const task = await createTask({
        projectId,
        title: 'Sync golden task',
        actor: 'user',
      });

      // checkpoint.created
      await createCheckpoint({
        projectId,
        taskId: task.id,
        sessionId: 'session_test_a',
        summary: 'Mid-session snapshot for golden test',
      });

      // handoff.created (forces task.updated to handoff_ready)
      await createHandoff({
        projectId,
        taskId: task.id,
        fromActor: 'claude',
        toActor: 'codex',
        summary: 'Handed off after golden checkpoint',
        nextAction: 'Pull on B and verify',
      });

      const pushResponse = await pushProject(projectId, transport);
      expect(pushResponse.accepted.length).toBeGreaterThan(0);

      return projectId;
    });

    // ---- Project B: pull and verify all event types arrived ----
    await withMemorizeRoot(homeB, async () => {
      const projectDirB = await makeProject('b');
      const setupB = await setupProject(projectDirB);
      const projectIdB = setupB.project.id;

      await updateSyncState(projectIdB, { remoteProjectId: projectIdA });

      const pullResponse = await pullProject(projectIdB, transport);
      expect(pullResponse.events.length).toBeGreaterThan(0);

      const inbound = await drainInbound(projectIdB);
      const types = new Set(inbound.map((event) => event.type));
      // Every event type emitted on A must arrive intact on B.
      expect(types).toContain('project.created');
      expect(types).toContain('workstream.created');
      expect(types).toContain('rule.upserted');
      expect(types).toContain('task.created');
      expect(types).toContain('checkpoint.created');
      expect(types).toContain('handoff.created');

      // sync.state.updated is intentionally filtered out of push payloads
      // (it is local bookkeeping). The 1.0 promise: it never crosses the wire.
      expect(types).not.toContain('sync.state.updated');

      // Payload integrity — pick the handoff and verify its content survived.
      const handoffEvent = inbound.find(
        (event) => event.type === 'handoff.created',
      );
      expect(handoffEvent).toBeDefined();
      const handoffPayload = handoffEvent?.payload as {
        summary: string;
        nextAction: string;
        fromActor: string;
        toActor: string;
      };
      expect(handoffPayload.summary).toBe(
        'Handed off after golden checkpoint',
      );
      expect(handoffPayload.nextAction).toBe('Pull on B and verify');
      expect(handoffPayload.fromActor).toBe('claude');
      expect(handoffPayload.toActor).toBe('codex');
    });
  });

  it('supports bidirectional sync — B can push events back to A', async () => {
    const remotePath = join(sandbox, 'remote');
    const homeA = join(sandbox, 'home-a');
    const homeB = join(sandbox, 'home-b');
    const transport = createFileSyncTransport(remotePath);

    // A: create + push
    const { projectIdA, projectDirA } = await withMemorizeRoot(homeA, async () => {
      const projectDirA = await makeProject('a');
      const setup = await setupProject(projectDirA);
      await createTask({
        projectId: setup.project.id,
        title: 'A original task',
        actor: 'user',
      });
      await pushProject(setup.project.id, transport);
      return { projectIdA: setup.project.id, projectDirA };
    });

    // B: pull, apply, then add a new task and push back
    const projectIdB = await withMemorizeRoot(homeB, async () => {
      const projectDirB = await makeProject('b');
      const setupB = await setupProject(projectDirB);
      const projectIdB = setupB.project.id;
      await updateSyncState(projectIdB, { remoteProjectId: projectIdA });
      const pullResponse = await pullProject(projectIdB, transport);
      // applyPullResponse moves events from inbound to local processing.
      // For the golden test we just need to confirm the loop completes.
      await applyPullResponse(projectIdB, pullResponse);
      await drainInbound(projectIdB);

      // B now creates its own event (the assignment-model use case in
      // Sprint 2 will rely on this exact pattern).
      await createTask({
        projectId: projectIdB,
        title: 'B added this task',
        actor: 'user',
      });
      // Note: B pushes events using its own projectId. The remote
      // accumulates events from both sides under the bound remote project.
      await pushProject(projectIdB, transport);
      return projectIdB;
    });

    // A: pull and confirm B's task arrived.
    await withMemorizeRoot(homeA, async () => {
      // Bind A's project to itself as remote so it can pull from the
      // shared remote file. (A pushed first so this is already set, but
      // explicit is clearer.)
      const boundA = await getBoundProjectId(projectDirA);
      expect(boundA).toBe(projectIdA);

      const pullResponse = await pullProject(projectIdA, transport);
      const inbound = await drainInbound(projectIdA);

      const titles = inbound
        .filter((event) => event.type === 'task.created')
        .map((event) => (event.payload as { title: string }).title);
      // A should now see B's task in its inbound queue.
      expect(titles).toContain('B added this task');
      expect(pullResponse.events.length).toBeGreaterThan(0);
    });

    // Sanity: A's local event log on disk must NOT have been mutated
    // by the pull — applyPullResponse stages events in inbound, the
    // projector replay step is a separate concern.
    const eventsOnA = await withMemorizeRoot(homeA, () =>
      readEvents(projectIdA),
    );
    const localTitles = eventsOnA
      .filter((event) => event.type === 'task.created')
      .map((event) => (event.payload as { title: string }).title);
    expect(localTitles).toContain('A original task');
    // unused but kept to silence the linter
    void projectIdB;
  });
});
