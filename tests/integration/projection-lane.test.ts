import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../src/domain/common.js';
import {
  listTasks,
  listValidMemories,
  rebuildProjectProjection,
} from '../../src/services/projection-store.js';
import { searchProject } from '../../src/services/search-service.js';
import { closeAll, getDb } from '../../src/storage/db.js';
import { appendEvent } from '../../src/storage/event-store.js';

// M2 `(entity, writer)` projection, persistence + selector side: a foreign
// origin store's rows (simulated via the `sourceProjectId` provenance override)
// land in the SAME db but carry their lane in `source_project_id`. The single
// private-vs-union selector keeps the default (self) reads free of the foreign
// lane, and a `union` read surfaces both — never folding them together.

const projectId = 'proj_lane_self';
const FOREIGN = 'proj_lane_bob';
const ts = '2026-06-01T00:00:00.000Z';

let sandbox: string;

function taskPayload(id: string, title: string) {
  return {
    id,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: ts,
    updatedAt: ts,
    projectId,
    workstreamId: 'ws_1',
    title,
    description: 'desc',
    status: 'in_progress',
    priority: 'high',
    ownerType: 'unassigned',
    goal: 'g',
    acceptanceCriteria: [],
    dependsOn: [],
    contextRefIds: [],
    decisionRefIds: [],
    ruleRefIds: [],
    openQuestions: [],
    riskNotes: [],
  };
}

function memoryPayload(id: string, text: string) {
  return {
    id,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: ts,
    updatedAt: ts,
    projectId,
    kind: 'insight',
    text,
    salience: 3,
    sourceObservationIds: [],
  };
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-lane-'));
  process.env.MEMORIZE_ROOT = sandbox;

  await appendEvent({
    type: 'project.created',
    projectId,
    scopeType: 'project',
    scopeId: projectId,
    actor: 'test',
    payload: {
      id: projectId,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: ts,
      updatedAt: ts,
      title: 'Self',
      summary: 'self store',
      goals: [],
      status: 'active',
      rootPath: '/tmp/self',
      activeWorkstreamIds: [],
      activeTaskIds: [],
      acceptedDecisionIds: [],
      ruleIds: [],
    } as never,
  });
  // Self task + memory (no provenance override → self lane, NULL column).
  await appendEvent({
    type: 'task.created',
    projectId,
    scopeType: 'task',
    scopeId: 'task_self',
    actor: 'test',
    payload: taskPayload('task_self', 'alpha self task') as never,
  });
  await appendEvent({
    type: 'memory.consolidated',
    projectId,
    scopeType: 'project',
    scopeId: projectId,
    actor: 'test',
    payload: memoryPayload('mem_self', 'alpha self memory') as never,
  });
  // Foreign task + memory carried in by a union: same store, foreign lane.
  await appendEvent({
    type: 'task.created',
    projectId,
    scopeType: 'task',
    scopeId: 'task_bob',
    actor: 'test',
    sourceProjectId: FOREIGN,
    payload: taskPayload('task_bob', 'alpha bob task') as never,
  });
  await appendEvent({
    type: 'memory.consolidated',
    projectId,
    scopeType: 'project',
    scopeId: projectId,
    actor: 'test',
    sourceProjectId: FOREIGN,
    payload: memoryPayload('mem_bob', 'alpha bob memory') as never,
  });

  await rebuildProjectProjection(projectId);
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('projection lane selector (M2)', () => {
  it('stores the lane in source_project_id: NULL for self, origin id for foreign', () => {
    const rows = getDb(projectId)
      .prepare('SELECT id, source_project_id AS lane FROM tasks ORDER BY id')
      .all() as Array<{ id: string; lane: string | null }>;
    expect(rows).toEqual([
      { id: 'task_bob', lane: FOREIGN },
      { id: 'task_self', lane: null },
    ]);
  });

  it('listTasks defaults to self; union surfaces both without folding', () => {
    expect(listTasks(projectId).map((t) => t.id)).toEqual(['task_self']);
    expect(
      listTasks(projectId, {}, 'union')
        .map((t) => t.id)
        .sort(),
    ).toEqual(['task_bob', 'task_self']);
  });

  it('listValidMemories defaults to self; union surfaces both', () => {
    expect(listValidMemories(projectId).map((r) => r.memory.id)).toEqual([
      'mem_self',
    ]);
    expect(
      listValidMemories(projectId, 'union')
        .map((r) => r.memory.id)
        .sort(),
    ).toEqual(['mem_bob', 'mem_self']);
  });

  it('searchProject defaults to self; union searches every lane', () => {
    const self = searchProject(projectId, 'alpha').map((h) => h.entityId).sort();
    expect(self).toEqual(['mem_self', 'task_self']);
    const union = searchProject(projectId, 'alpha', 20, 'union')
      .map((h) => h.entityId)
      .sort();
    expect(union).toEqual(['mem_bob', 'mem_self', 'task_bob', 'task_self']);
  });
});
