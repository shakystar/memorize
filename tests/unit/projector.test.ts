import { describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../src/domain/common.js';
import type { DomainEvent } from '../../src/domain/events.js';
import { buildMemoryIndex, reduceProjectState } from '../../src/projections/projector.js';

function makeEvent(overrides: Partial<DomainEvent>): DomainEvent {
  return {
    id: 'evt_1',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: '2026-04-11T00:00:00.000Z',
    updatedAt: '2026-04-11T00:00:00.000Z',
    type: 'project.created',
    projectId: 'proj_1',
    scopeType: 'project',
    scopeId: 'proj_1',
    actor: 'test',
    payload: {},
    ...overrides,
  } as DomainEvent;
}

describe('projector', () => {
  it('reduces events into project state and memory index', () => {
    const state = reduceProjectState([
      makeEvent({
        type: 'project.created',
        payload: {
          id: 'proj_1',
          schemaVersion: CURRENT_SCHEMA_VERSION,
          createdAt: '2026-04-11T00:00:00.000Z',
          updatedAt: '2026-04-11T00:00:00.000Z',
          title: 'Memorize',
          summary: 'Shared context system',
          goals: [],
          status: 'active',
          rootPath: '/tmp/memorize',
          activeWorkstreamIds: [],
          activeTaskIds: [],
          acceptedDecisionIds: [],
          ruleIds: [],
        },
      }),
      makeEvent({
        id: 'evt_2',
        type: 'workstream.created',
        scopeType: 'workstream',
        scopeId: 'ws_1',
        payload: {
          id: 'ws_1',
          schemaVersion: CURRENT_SCHEMA_VERSION,
          createdAt: '2026-04-11T00:00:00.000Z',
          updatedAt: '2026-04-11T00:00:00.000Z',
          projectId: 'proj_1',
          title: 'default',
          summary: 'Default stream',
          status: 'active',
        },
      }),
      makeEvent({
        id: 'evt_3',
        type: 'task.created',
        scopeType: 'task',
        scopeId: 'task_1',
        payload: {
          id: 'task_1',
          schemaVersion: CURRENT_SCHEMA_VERSION,
          createdAt: '2026-04-11T00:00:00.000Z',
          updatedAt: '2026-04-11T00:00:00.000Z',
          projectId: 'proj_1',
          workstreamId: 'ws_1',
          title: 'First task',
          description: 'Do the thing',
          status: 'todo',
          priority: 'high',
          ownerType: 'unassigned',
          goal: 'Do the thing',
          acceptanceCriteria: [],
          dependsOn: [],
          contextRefIds: [],
          decisionRefIds: [],
          ruleRefIds: [],
          openQuestions: [],
          riskNotes: [],
        },
      }),
      makeEvent({
        id: 'evt_4',
        type: 'decision.accepted',
        scopeType: 'project',
        scopeId: 'proj_1',
        payload: {
          id: 'dec_1',
          schemaVersion: CURRENT_SCHEMA_VERSION,
          createdAt: '2026-04-11T00:00:00.000Z',
          updatedAt: '2026-04-11T00:00:00.000Z',
          scopeType: 'project',
          scopeId: 'proj_1',
          title: 'Use event log',
          decision: 'Use append-only events',
          rationale: 'Rebuildability',
          status: 'accepted',
          relatedRuleIds: [],
          createdBy: 'user',
        },
      }),
    ]);

    expect(state.project?.activeWorkstreamIds).toEqual(['ws_1']);
    expect(state.project?.activeTaskIds).toEqual(['task_1']);
    expect(state.project?.acceptedDecisionIds).toEqual(['dec_1']);

    const index = buildMemoryIndex(state);
    expect(index.projectId).toBe('proj_1');
    expect(index.shortSummary).toBe('Shared context system');
    expect(index.topTasks).toHaveLength(1);
    expect(index.recentDecisions).toHaveLength(1);
  });
});
