import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHttpSyncTransport } from '../../src/adapters/sync-transport-http.js';
import { getBoundProjectId } from '../../src/services/project-service.js';
import {
  bumpHeartbeat,
  startSession,
} from '../../src/services/session-service.js';
import { setupProject } from '../../src/services/setup-service.js';
import {
  cloneProject,
  pullProject,
  pushProject,
} from '../../src/services/sync-service.js';
import {
  createCheckpoint,
  createHandoff,
  createTask,
  updateTask,
} from '../../src/services/task-service.js';
import { closeAll } from '../../src/storage/db.js';
import { readEvents } from '../../src/storage/event-store.js';
import { startRelayStub, type RelayStub } from '../harness/relay-stub.js';

/**
 * The file golden (sync-roundtrip-golden.test.ts) over the P3-b-2 HTTP relay
 * transport instead of a shared folder. Same true-replica invariants — events
 * cross the wire, exactly one identity survives, sync bookkeeping stays local —
 * proving the http transport is a drop-in sibling of the file transport.
 */

let sandbox: string;
let relay: RelayStub;

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
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-sync-http-golden-'));
  relay = await startRelayStub();
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await relay?.close();
  await rm(sandbox, { recursive: true, force: true });
});

describe('sync golden over http relay — true-replica baseline', () => {
  it('roundtrips every supported event type from A to a clone B', async () => {
    const homeA = join(sandbox, 'home-a');
    const homeB = join(sandbox, 'home-b');
    const transport = createHttpSyncTransport(relay.baseUrl);
    const httpCfg = { type: 'http' as const, url: relay.baseUrl };

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
      await updateTask(projectId, task.id, { status: 'in_progress' }, 'user');
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

    await withMemorizeRoot(homeB, async () => {
      const projectDirB = await makeProject('b');
      const clone = await cloneProject(
        projectDirB,
        projectIdA,
        transport,
        httpCfg,
      );
      expect(clone.projectId).toBe(projectIdA);
      expect(clone.pulled).toBeGreaterThan(0);

      const allEvents = await readEvents(projectIdA);
      const types = new Set(allEvents.map((event) => event.type));
      expect(types).toContain('project.created');
      expect(types).toContain('workstream.created');
      expect(types).toContain('rule.upserted');
      expect(types).toContain('task.created');
      expect(types).toContain('checkpoint.created');
      expect(types).toContain('handoff.created');
      expect(types).toContain('session.started');
      expect(types).toContain('session.heartbeat');
      expect(
        allEvents.filter((e) => e.type === 'project.created'),
      ).toHaveLength(1);

      // sync.state.updated is local bookkeeping and MUST NOT cross the wire —
      // assert it on the actual relay log.
      expect(
        relay.events(projectIdA).some((e) => e.type === 'sync.state.updated'),
      ).toBe(false);

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
    const homeA = join(sandbox, 'home-a');
    const homeB = join(sandbox, 'home-b');
    const transport = createHttpSyncTransport(relay.baseUrl);
    const httpCfg = { type: 'http' as const, url: relay.baseUrl };

    const { projectIdA, projectDirA } = await withMemorizeRoot(
      homeA,
      async () => {
        const dir = await makeProject('a');
        const setup = await setupProject(dir);
        await createTask({
          projectId: setup.project.id,
          title: 'A original task',
          actor: 'user',
        });
        await pushProject(setup.project.id, transport);
        return { projectIdA: setup.project.id, projectDirA: dir };
      },
    );

    await withMemorizeRoot(homeB, async () => {
      const projectDirB = await makeProject('b');
      const clone = await cloneProject(
        projectDirB,
        projectIdA,
        transport,
        httpCfg,
      );
      expect(clone.pulled).toBeGreaterThan(0);
      await createTask({
        projectId: projectIdA,
        title: 'B added this task',
        actor: 'user',
      });
      await pushProject(projectIdA, transport);
    });

    await withMemorizeRoot(homeA, async () => {
      expect(await getBoundProjectId(projectDirA)).toBe(projectIdA);
      const pullResult = await pullProject(projectIdA, transport);
      expect(pullResult.total).toBeGreaterThan(0);

      const titles = (await readEvents(projectIdA))
        .filter((event) => event.type === 'task.created')
        .map((event) => (event.payload as { title: string }).title);
      expect(titles).toContain('A original task');
      expect(titles).toContain('B added this task');
      expect(
        (await readEvents(projectIdA)).filter(
          (e) => e.type === 'project.created',
        ),
      ).toHaveLength(1);
    });
  });
});
