import { describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../src/domain/common.js';
import type { DomainEvent } from '../../src/domain/events.js';
import { buildMemoryIndex, reduceProjectState } from '../../src/projections/projector.js';

// M2 `(entity, writer)` projection: events carry a provenance lane
// (`sourceProjectId` = origin store). The reducer must never fold a foreign
// lane's row into THIS store's "current X" (SoT-040), while still keeping the
// foreign rows in state (they surface later through the union selector). The
// self lane keys by bare id → single-writer projections are unchanged.

const SELF = 'proj_self';
const FOREIGN = 'proj_bob';
const ts = '2026-05-01T00:00:00.000Z';

function evt(o: Partial<DomainEvent> & Pick<DomainEvent, 'id' | 'type'>): DomainEvent {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: ts,
    updatedAt: ts,
    projectId: SELF,
    scopeType: 'project',
    scopeId: SELF,
    actor: 'test',
    payload: {},
    ...o,
  } as DomainEvent;
}

function projectCreated(): DomainEvent {
  return evt({
    id: 'evt_p',
    type: 'project.created',
    payload: {
      id: SELF,
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
}

function taskCreated(
  id: string,
  scopeId: string,
  sourceProjectId: string | undefined,
): DomainEvent {
  return evt({
    id,
    type: 'task.created',
    scopeType: 'task',
    scopeId,
    ...(sourceProjectId ? { sourceProjectId } : {}),
    payload: {
      id: scopeId,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: ts,
      updatedAt: ts,
      projectId: SELF,
      workstreamId: 'ws_1',
      title: `task ${scopeId}`,
      description: 'x',
      status: 'in_progress',
      priority: 'high',
      ownerType: 'unassigned',
      goal: 'x',
      acceptanceCriteria: [],
      dependsOn: [],
      contextRefIds: [],
      decisionRefIds: [],
      ruleRefIds: [],
      openQuestions: [],
      riskNotes: [],
    } as never,
  });
}

function sessionStarted(
  id: string,
  scopeId: string,
  sourceProjectId: string | undefined,
): DomainEvent {
  return evt({
    id,
    type: 'session.started',
    scopeType: 'session',
    scopeId,
    actor: 'claude',
    ...(sourceProjectId ? { sourceProjectId } : {}),
    payload: {
      id: scopeId,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: ts,
      updatedAt: ts,
      projectId: SELF,
      actor: 'claude',
      startedAt: ts,
      lastSeenAt: ts,
      status: 'active',
    } as never,
  });
}

function memoryConsolidated(
  id: string,
  sourceProjectId: string | undefined,
  opts: { text?: string; sourceObservationIds?: string[]; createdAt?: string } = {},
): DomainEvent {
  return evt({
    id: `evt_${id}`,
    type: 'memory.consolidated',
    scopeType: 'project',
    scopeId: SELF,
    ...(sourceProjectId ? { sourceProjectId } : {}),
    payload: {
      id,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: opts.createdAt ?? ts,
      updatedAt: opts.createdAt ?? ts,
      projectId: SELF,
      kind: 'insight',
      text: opts.text ?? `memory ${id}`,
      salience: 3,
      sourceObservationIds: opts.sourceObservationIds ?? [],
    } as never,
  });
}

describe('projector lane (M2)', () => {
  it('excludes a foreign lane from activeTaskIds / topTasks but keeps its row', () => {
    const state = reduceProjectState([
      projectCreated(),
      taskCreated('evt_ts', 'task_self', undefined),
      taskCreated('evt_tb', 'task_bob', FOREIGN),
    ]);

    // The fold that SoT-040 forbids: a foreign writer's task must not become
    // THIS store's current task.
    expect(state.project?.activeTaskIds).toEqual(['task_self']);
    expect(buildMemoryIndex(state).topTasks.map((t) => t.id)).toEqual([
      'task_self',
    ]);
    // ...but the foreign row is retained for the union selector.
    expect(Object.values(state.tasks)).toHaveLength(2);
    const ids = Object.values(state.tasks)
      .map((t) => t.id)
      .sort();
    expect(ids).toEqual(['task_bob', 'task_self']);
  });

  it('self memories stay untagged; a foreign memory carries its origin lane', () => {
    const state = reduceProjectState([
      projectCreated(),
      memoryConsolidated('mem_self', undefined),
      memoryConsolidated('mem_bob', FOREIGN),
    ]);

    expect(state.memories['mem_self']?.sourceProjectId).toBeUndefined();
    expect(state.memories['mem_bob']?.sourceProjectId).toBe(FOREIGN);
  });

  it('dedups same-lane replica duplicates but never across lanes', () => {
    const dupArgs = {
      text: 'same gist',
      sourceObservationIds: ['obs_1'],
    };
    const state = reduceProjectState([
      projectCreated(),
      // Two self replicas of the same window → collapse to one valid winner.
      memoryConsolidated('mem_self_a', undefined, {
        ...dupArgs,
        createdAt: '2026-05-01T00:00:00.000Z',
      }),
      memoryConsolidated('mem_self_b', undefined, {
        ...dupArgs,
        createdAt: '2026-05-02T00:00:00.000Z',
      }),
      // A foreign writer's identical assertion must stay independently valid.
      memoryConsolidated('mem_bob', FOREIGN, dupArgs),
    ]);

    // Winner (earliest) self memory + the foreign one remain valid; the later
    // self replica is the dedup loser. The foreign lane is untouched.
    expect(state.memories['mem_self_a']?.invalidAt).toBeUndefined();
    expect(state.memories['mem_self_b']?.dedupedBy).toBe('mem_self_a');
    expect(state.memories['mem_bob']?.invalidAt).toBeUndefined();
    expect(state.memories['mem_bob']?.dedupedBy).toBeUndefined();
  });

  it('treats an event whose sourceProjectId equals the self store as self', () => {
    // Legacy/local events may stamp their own store id explicitly; that is still
    // the self lane, so activeTaskIds must include it with a bare key.
    const state = reduceProjectState([
      projectCreated(),
      taskCreated('evt_ts', 'task_self', SELF),
    ]);
    expect(state.project?.activeTaskIds).toEqual(['task_self']);
    expect(state.tasks['task_self']).toBeDefined();
  });

  it('does not collide two lanes that share a scopeId (composite key)', () => {
    const state = reduceProjectState([
      projectCreated(),
      taskCreated('evt_ts', 'task_x', undefined),
      taskCreated('evt_tb', 'task_x', FOREIGN),
    ]);
    // Same scopeId, two lanes → two distinct rows, no overwrite.
    expect(Object.values(state.tasks)).toHaveLength(2);
    // Only the self one is "current".
    expect(state.project?.activeTaskIds).toEqual(['task_x']);
    expect(state.tasks['task_x']).toBeDefined(); // self keeps the bare key
  });

  it('routes a session update to the matching lane only', () => {
    const state = reduceProjectState([
      projectCreated(),
      sessionStarted('evt_ss', 'sess_x', undefined),
      sessionStarted('evt_sb', 'sess_x', FOREIGN),
      // Completing the FOREIGN session must not touch the self session.
      evt({
        id: 'evt_done',
        type: 'session.completed',
        scopeType: 'session',
        scopeId: 'sess_x',
        sourceProjectId: FOREIGN,
        payload: {},
      }),
    ]);

    const sessions = Object.values(state.sessions);
    expect(sessions).toHaveLength(2);
    const self = state.sessions['sess_x'];
    expect(self?.status).toBe('active'); // untouched
    const foreign = Object.entries(state.sessions).find(
      ([key]) => key !== 'sess_x',
    )?.[1];
    expect(foreign?.status).toBe('completed');
  });
});
