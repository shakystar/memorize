import { describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../src/domain/common.js';
import type { DomainEvent } from '../../src/domain/events.js';
import { parseLaneKey, reduceProjectState } from '../../src/projections/projector.js';

// W-a (SoT-021/022): a workspace union carries MULTIPLE distinct project.created
// (one per member's whole-DB union) into one store. The reducer must treat only
// the AUTHORITATIVE self proj_ as identity and every foreign member's genesis as
// a provenance label — never throwing #30 divergence, never mis-anchoring self by
// seq order. There is NO workspace.created event (identity is control-plane).

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

function projectCreated(id: string, sourceProjectId?: string): DomainEvent {
  return evt({
    id: `evt_p_${id}`,
    type: 'project.created',
    projectId: id,
    scopeId: id,
    // A foreign member's genesis arrives stamped with its own origin store id.
    ...(sourceProjectId ? { sourceProjectId } : {}),
    payload: {
      id,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: ts,
      updatedAt: ts,
      title: id,
      summary: `${id} store`,
      goals: [],
      status: 'active',
      rootPath: `/tmp/${id}`,
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

describe('projector workspace union (W-a, SoT-021/022)', () => {
  it('reduces a two-member union without throwing; self identity wins even when the foreign genesis is at a lower seq', () => {
    // FOREIGN genesis FIRST (lower seq) — the old first-by-seq prescan would have
    // mis-anchored self on it. With an authoritative selfId that cannot happen.
    const events = [
      projectCreated(FOREIGN, FOREIGN),
      taskCreated('evt_tb', 'task_bob', FOREIGN),
      projectCreated(SELF),
      taskCreated('evt_ts', 'task_self', undefined),
    ];

    const state = reduceProjectState(events, SELF);

    // No throw; the SELF genesis is the store identity, not the lower-seq foreign one.
    expect(state.project?.id).toBe(SELF);
    // Foreign entities are retained but in a foreign lane (composite key).
    expect(Object.values(state.tasks)).toHaveLength(2);
    const laneOfTaskBob = Object.keys(state.tasks)
      .map(parseLaneKey)
      .find((k) => k.id === 'task_bob');
    expect(laneOfTaskBob?.lane).toBe(FOREIGN);
    // Only the self task is "current".
    expect(state.project?.activeTaskIds).toEqual(['task_self']);
  });

  it('is order-independent: self genesis first also anchors on self', () => {
    const state = reduceProjectState(
      [
        projectCreated(SELF),
        projectCreated(FOREIGN, FOREIGN),
        taskCreated('evt_tb', 'task_bob', FOREIGN),
      ],
      SELF,
    );
    expect(state.project?.id).toBe(SELF);
    expect(state.project?.activeTaskIds).toEqual([]);
  });

  it('a foreign genesis whose id equals the authoritative self is idempotent (re-pull), not divergence', () => {
    const state = reduceProjectState(
      [projectCreated(SELF), projectCreated(SELF)],
      SELF,
    );
    expect(state.project?.id).toBe(SELF);
  });

  it('BACKWARD COMPAT: without an explicit selfId, a single-identity log still reduces', () => {
    const state = reduceProjectState([projectCreated(SELF)]);
    expect(state.project?.id).toBe(SELF);
  });

  it('BACKWARD COMPAT: without an explicit selfId, two DISTINCT genesis still throw (#30)', () => {
    // The legacy divergence guard must remain for callers that do not pass selfId.
    expect(() =>
      reduceProjectState([projectCreated(SELF), projectCreated(FOREIGN, FOREIGN)]),
    ).toThrow(/Divergent project identity/);
  });

  it('with an authoritative selfId, the SAME two-genesis log does NOT throw (union, not clobber)', () => {
    expect(() =>
      reduceProjectState(
        [projectCreated(SELF), projectCreated(FOREIGN, FOREIGN)],
        SELF,
      ),
    ).not.toThrow();
  });

  it('routes a foreign member LEGACY block (no provenance) to its own lane in a union log', () => {
    // The 3.0.0 dogfood regression: a member's whole-DB push carries its
    // pre-provenance events with NULL sourceProjectId as-is. In a union log the
    // event's own projectId is the origin proxy — the block must land in the
    // member's lane, not self.
    const legacyForeignTask = evt({
      id: 'evt_tb_legacy',
      type: 'task.created',
      scopeType: 'task',
      scopeId: 'task_bob_legacy',
      projectId: FOREIGN,
      payload: {
        id: 'task_bob_legacy',
        schemaVersion: CURRENT_SCHEMA_VERSION,
        createdAt: ts,
        updatedAt: ts,
        projectId: FOREIGN,
        workstreamId: 'ws_1',
        title: 'legacy foreign task',
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

    const state = reduceProjectState(
      [
        projectCreated(SELF),
        // Legacy foreign genesis: NULL provenance, rides under its own projectId.
        projectCreated(FOREIGN),
        legacyForeignTask,
        taskCreated('evt_ts', 'task_self', undefined),
      ],
      SELF,
    );

    // No divergent-identity throw; self identity holds.
    expect(state.project?.id).toBe(SELF);
    // The legacy foreign task lands in the FOREIGN lane, not self.
    const laneOfLegacy = Object.keys(state.tasks)
      .map(parseLaneKey)
      .find((k) => k.id === 'task_bob_legacy');
    expect(laneOfLegacy?.lane).toBe(FOREIGN);
    // Only the self task is "current".
    expect(state.project?.activeTaskIds).toEqual(['task_self']);
  });

  it('keeps NULL-provenance events in the self lane when the log is NOT a union', () => {
    // Single-genesis log where the authoritative dir id differs from the
    // genesis (cross-dir migrate round-trip): the projectId-as-origin proxy is
    // gated on isUnion, so the store's own legacy history must stay self even
    // though its projectId matches neither the genesis anchor nor the dir id.
    const state = reduceProjectState(
      [projectCreated(SELF), taskCreated('evt_ts', 'task_self', undefined)],
      'proj_migrated_dir',
    );
    expect(state.project?.id).toBe(SELF);
    expect(state.project?.activeTaskIds).toEqual(['task_self']);
    expect(state.tasks['task_self']).toBeDefined();
  });
});
