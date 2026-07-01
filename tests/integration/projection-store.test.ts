import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../src/domain/common.js';
import type { DomainEvent } from '../../src/domain/events.js';
import { reduceProjectState } from '../../src/projections/projector.js';
import { migrateProjectFromNdjson } from '../../src/services/migrate-service.js';
import {
  getMemoryIndex,
  getProjectProjection,
  getTask,
  listSessions,
  rebuildProjectProjection,
} from '../../src/services/projection-store.js';
import { doctor } from '../../src/services/repair-service.js';
import { bindProject } from '../../src/storage/bindings-store.js';
import { closeAll, getDb } from '../../src/storage/db.js';
import { appendEvent, readEvents } from '../../src/storage/event-store.js';

const projectId = 'proj_pstore_test1';

let sandbox: string;

const ts = '2026-02-02T00:00:00.000Z';

function evt(
  overrides: Partial<DomainEvent> & Pick<DomainEvent, 'id' | 'type'>,
): DomainEvent {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: ts,
    updatedAt: ts,
    projectId,
    scopeType: 'project',
    scopeId: projectId,
    actor: 'test',
    payload: {},
    ...overrides,
  } as DomainEvent;
}

const seedEvents: DomainEvent[] = [
  evt({
    id: 'evt_p',
    type: 'project.created',
    payload: {
      id: projectId,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: ts,
      updatedAt: ts,
      title: 'PStore',
      summary: 'projection store project',
      goals: [],
      status: 'active',
      rootPath: '/tmp/pstore',
      activeWorkstreamIds: [],
      activeTaskIds: [],
      acceptedDecisionIds: [],
      ruleIds: [],
    } as never,
  }),
  evt({
    id: 'evt_t1',
    type: 'task.created',
    scopeType: 'task',
    scopeId: 'task_1',
    payload: {
      id: 'task_1',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: ts,
      updatedAt: ts,
      projectId,
      workstreamId: 'ws_1',
      title: 'First task',
      description: 'first',
      status: 'todo',
      priority: 'high',
      ownerType: 'unassigned',
      goal: 'first',
      acceptanceCriteria: [],
      dependsOn: [],
      contextRefIds: [],
      decisionRefIds: [],
      ruleRefIds: [],
      openQuestions: [],
      riskNotes: [],
    } as never,
  }),
  evt({
    id: 'evt_s1',
    type: 'session.started',
    scopeType: 'session',
    scopeId: 'sess_1',
    actor: 'claude',
    payload: {
      id: 'sess_1',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: ts,
      updatedAt: ts,
      projectId,
      actor: 'claude',
      startedAt: ts,
      lastSeenAt: ts,
      status: 'active',
    } as never,
  }),
];

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-pstore-'));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('projection store', () => {
  it('round-trips: reduce → writeProjection → read back == reduced entities', async () => {
    for (const event of seedEvents) {
      await appendEvent({
        type: event.type,
        projectId,
        scopeType: event.scopeType,
        scopeId: event.scopeId,
        actor: event.actor,
        payload: event.payload as never,
      });
    }
    // appendEvent mints fresh ids/timestamps, so derive expectations from the
    // reduction of the ACTUAL stored events, not from seedEvents.
    const stored = await readEvents(projectId);
    const expected = reduceProjectState(stored);

    await rebuildProjectProjection(projectId);

    expect(getProjectProjection(projectId)).toEqual(expected.project);
    const taskId = Object.keys(expected.tasks)[0]!;
    expect(getTask(projectId, taskId)).toEqual(expected.tasks[taskId]);
    const sessions = listSessions(projectId);
    expect(sessions).toHaveLength(Object.keys(expected.sessions).length);
    expect(getMemoryIndex(projectId)?.projectId).toBe(projectId);
  });

  it('migrate builds the projection tables from imported events', async () => {
    const eventsDir = join(sandbox, 'accounts', 'local_default', 'projects', projectId, 'events');
    await mkdir(eventsDir, { recursive: true });
    await writeFile(
      join(eventsDir, '2026-02-02.ndjson'),
      seedEvents.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8',
    );

    const result = await migrateProjectFromNdjson(projectId);
    expect(result.status).toBe('migrated');

    // Tables are populated without an explicit `projection rebuild`.
    expect(getProjectProjection(projectId)?.id).toBe(projectId);
    expect(getTask(projectId, 'task_1')?.title).toBe('First task');
  });

  it('doctor --rebuild equivalent (projection rebuild) reconstructs tables matching the reduced state', async () => {
    for (const event of seedEvents) {
      await appendEvent({
        type: event.type,
        projectId,
        scopeType: event.scopeType,
        scopeId: event.scopeId,
        actor: event.actor,
        payload: event.payload as never,
      });
    }
    await rebuildProjectProjection(projectId);

    // Simulate a stale/empty projection (e.g. interrupted rebuild) by wiping
    // the project row, then prove doctor flags it.
    await bindProject(sandbox, projectId);
    getDb(projectId).prepare('DELETE FROM projects').run();
    const before = await doctor(sandbox);
    const builtCheck = before.checks.find((c) => c.id === 'projection.built');
    expect(builtCheck?.status).toBe('warn');

    // Rebuild reconstructs tables; the reduced-from-events state matches.
    await rebuildProjectProjection(projectId);
    const expected = reduceProjectState(await readEvents(projectId));
    expect(getProjectProjection(projectId)).toEqual(expected.project);

    const after = await doctor(sandbox);
    expect(
      after.checks.find((c) => c.id === 'projection.built')?.status,
    ).toBe('ok');
  });
});
