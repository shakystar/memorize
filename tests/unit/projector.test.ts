import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../src/domain/common.js';
import type { DomainEvent } from '../../src/domain/events.js';
import {
  MAX_RECENT_DECISIONS,
  MAX_TOP_TASKS,
  buildMemoryIndex,
  reduceProjectState,
} from '../../src/projections/projector.js';

const FIXTURE_ROOT = path.join(tmpdir(), 'memorize-test-projector');

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
          rootPath: FIXTURE_ROOT,
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

  it('excludes done tasks from activeTaskIds and topTasks', () => {
    const state = reduceProjectState([
      projectCreated(),
      taskEvent('task_open', 'in_progress', '2026-04-15T00:00:00.000Z'),
      taskEvent('task_done', 'done', '2026-04-16T00:00:00.000Z'),
    ]);

    expect(state.project?.activeTaskIds).toEqual(['task_open']);

    const index = buildMemoryIndex(state);
    expect(index.topTasks.map((t) => t.id)).toEqual(['task_open']);
  });

  it('excludes closed workstreams from activeWorkstreamIds and activeWorkstreams', () => {
    const state = reduceProjectState([
      projectCreated(),
      workstreamEvent('ws_open', 'active'),
      workstreamEvent('ws_closed', 'closed'),
    ]);

    expect(state.project?.activeWorkstreamIds).toEqual(['ws_open']);

    const index = buildMemoryIndex(state);
    expect(index.activeWorkstreams.map((w) => w.id)).toEqual(['ws_open']);
  });

  it('includes only accepted decisions in recentDecisions, sorted by recency', () => {
    const state = reduceProjectState([
      projectCreated(),
      decisionEvent('dec_proposed', 'proposed', '2026-04-10T00:00:00.000Z'),
      decisionEvent('dec_rejected', 'rejected', '2026-04-11T00:00:00.000Z'),
      decisionEvent('dec_old', 'accepted', '2026-04-12T00:00:00.000Z'),
      decisionEvent('dec_new', 'accepted', '2026-04-15T00:00:00.000Z'),
    ]);

    const index = buildMemoryIndex(state);
    expect(index.recentDecisions.map((d) => d.id)).toEqual([
      'dec_new',
      'dec_old',
    ]);
  });

  it('decision.superseded marks the old decision superseded and keeps the new one accepted', () => {
    const state = reduceProjectState([
      projectCreated(),
      decisionEvent('dec_old', 'accepted', '2026-04-12T00:00:00.000Z'),
      decisionEvent('dec_new', 'accepted', '2026-04-15T00:00:00.000Z'),
      makeEvent({
        id: 'evt_supersede',
        type: 'decision.superseded',
        scopeType: 'project',
        scopeId: 'dec_old',
        createdAt: '2026-04-16T00:00:00.000Z',
        payload: {
          supersedes: 'dec_old',
          supersededBy: 'dec_new',
          reason: 'replaced',
        },
      }),
    ]);

    expect(state.decisions['dec_old']?.status).toBe('superseded');
    expect(state.decisions['dec_old']?.supersededBy).toBe('dec_new');
    // Original row preserved (point-in-time replays still see it).
    expect(state.decisions['dec_old']).toBeDefined();
    // New decision stays accepted.
    expect(state.decisions['dec_new']?.status).toBe('accepted');
    // Projection drops the superseded one, keeps the new one.
    expect(state.project?.acceptedDecisionIds).toEqual(['dec_new']);
  });

  it('reduces session.started events into the sessions map', () => {
    const state = reduceProjectState([
      projectCreated(),
      sessionStartedEvent('sess_1', 'claude', 'task_1', '2026-04-20T00:00:00.000Z'),
    ]);
    expect(state.sessions['sess_1']).toMatchObject({
      id: 'sess_1',
      actor: 'claude',
      taskId: 'task_1',
      status: 'active',
      lastSeenAt: '2026-04-20T00:00:00.000Z',
    });
  });

  it('marks sessions completed and bumps lastSeenAt on session.completed', () => {
    const state = reduceProjectState([
      projectCreated(),
      sessionStartedEvent('sess_1', 'codex', undefined, '2026-04-20T00:00:00.000Z'),
      sessionCompletedEvent('sess_1', '2026-04-20T01:00:00.000Z'),
    ]);
    expect(state.sessions['sess_1']?.status).toBe('completed');
    expect(state.sessions['sess_1']?.endedAt).toBe('2026-04-20T01:00:00.000Z');
    expect(state.sessions['sess_1']?.lastSeenAt).toBe('2026-04-20T01:00:00.000Z');
  });

  it('bumps lastSeenAt on session.heartbeat without changing status', () => {
    const state = reduceProjectState([
      projectCreated(),
      sessionStartedEvent('sess_1', 'claude', undefined, '2026-04-20T00:00:00.000Z'),
      sessionHeartbeatEvent('sess_1', '2026-04-20T00:05:00.000Z'),
      sessionHeartbeatEvent('sess_1', '2026-04-20T00:10:00.000Z'),
    ]);
    expect(state.sessions['sess_1']?.status).toBe('active');
    expect(state.sessions['sess_1']?.lastSeenAt).toBe(
      '2026-04-20T00:10:00.000Z',
    );
  });

  it('ignores session.completed and session.heartbeat for unknown sessions', () => {
    const state = reduceProjectState([
      projectCreated(),
      sessionCompletedEvent('sess_missing', '2026-04-20T00:00:00.000Z'),
      sessionHeartbeatEvent('sess_missing', '2026-04-20T00:01:00.000Z'),
    ]);
    expect(state.sessions['sess_missing']).toBeUndefined();
  });

  it('is deterministic — reducing the same log twice yields deep-equal state', () => {
    // task.updated without an explicit updatedAt must fall back to the
    // triggering event's createdAt (NOT wall-clock nowIso()), so a replay
    // of the identical log produces byte-identical state. This is the
    // event-sourcing invariant the applyTaskUpdate fix protects.
    const log: DomainEvent[] = [
      projectCreated(),
      taskEvent('task_1', 'todo', '2026-04-11T00:00:00.000Z'),
      makeEvent({
        id: 'evt_task_1_upd',
        type: 'task.updated',
        scopeType: 'task',
        scopeId: 'task_1',
        createdAt: '2026-04-12T09:30:00.000Z',
        updatedAt: '2026-04-12T09:30:00.000Z',
        // No updatedAt in the payload → must inherit event.createdAt.
        payload: { status: 'in_progress' },
      }),
    ];

    const first = reduceProjectState(log);
    const second = reduceProjectState(log);
    expect(second).toEqual(first);
    // And the fallback used the event's createdAt, not the current time.
    expect(first.tasks['task_1']?.updatedAt).toBe('2026-04-12T09:30:00.000Z');
  });

  it('appends task.item-appended items in order and ignores unsafe payloads', () => {
    const itemEvent = (
      id: string,
      field: string,
      text: unknown,
      createdAt: string,
    ): DomainEvent =>
      makeEvent({
        id,
        type: 'task.item-appended',
        scopeType: 'task',
        scopeId: 'task_1',
        createdAt,
        updatedAt: createdAt,
        payload: { field, text },
      });

    const state = reduceProjectState([
      projectCreated(),
      taskEvent('task_1', 'in_progress', '2026-04-11T00:00:00.000Z'),
      itemEvent(
        'evt_q1',
        'openQuestions',
        'Which store wins on conflict?',
        '2026-04-12T00:00:00.000Z',
      ),
      itemEvent(
        'evt_q2',
        'openQuestions',
        'Does the Hub need pagination?',
        '2026-04-12T01:00:00.000Z',
      ),
      itemEvent(
        'evt_r1',
        'riskNotes',
        'Blocked on upstream API key',
        '2026-04-12T02:00:00.000Z',
      ),
      itemEvent(
        'evt_ac1',
        'acceptanceCriteria',
        'Panel renders questions',
        '2026-04-12T03:00:00.000Z',
      ),
      // A synced event must never append into an arbitrary Task property
      // or inject a non-string item — both are dropped, not applied.
      itemEvent('evt_bad1', 'title', 'hijacked', '2026-04-12T04:00:00.000Z'),
      itemEvent(
        'evt_bad2',
        'riskNotes',
        { nested: 'object' },
        '2026-04-12T05:00:00.000Z',
      ),
      // Append aimed at a task that does not exist in this lane: dropped.
      makeEvent({
        id: 'evt_bad3',
        type: 'task.item-appended',
        scopeType: 'task',
        scopeId: 'task_missing',
        createdAt: '2026-04-12T06:00:00.000Z',
        payload: { field: 'riskNotes', text: 'orphan' },
      }),
    ]);

    const task = state.tasks['task_1'];
    expect(task?.openQuestions).toEqual([
      'Which store wins on conflict?',
      'Does the Hub need pagination?',
    ]);
    expect(task?.riskNotes).toEqual(['Blocked on upstream API key']);
    expect(task?.acceptanceCriteria).toEqual(['Panel renders questions']);
    expect(task?.title).not.toBe('hijacked');
    // The last APPLIED append stamps updatedAt from the event's createdAt.
    expect(task?.updatedAt).toBe('2026-04-12T03:00:00.000Z');
    expect(state.tasks['task_missing']).toBeUndefined();
  });

  it('caps topTasks and recentDecisions at their configured maximums', () => {
    const taskEvents = Array.from({ length: MAX_TOP_TASKS + 5 }, (_, i) =>
      taskEvent(
        `task_${i}`,
        'in_progress',
        `2026-04-${String(10 + (i % 20)).padStart(2, '0')}T00:00:00.000Z`,
      ),
    );
    const decisionEvents = Array.from(
      { length: MAX_RECENT_DECISIONS + 5 },
      (_, i) =>
        decisionEvent(
          `dec_${i}`,
          'accepted',
          `2026-04-${String(10 + (i % 20)).padStart(2, '0')}T00:00:00.000Z`,
        ),
    );
    const state = reduceProjectState([
      projectCreated(),
      ...taskEvents,
      ...decisionEvents,
    ]);

    const index = buildMemoryIndex(state);
    expect(index.topTasks).toHaveLength(MAX_TOP_TASKS);
    expect(index.recentDecisions).toHaveLength(MAX_RECENT_DECISIONS);
  });
});

function projectCreated(): DomainEvent {
  return makeEvent({
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
      rootPath: FIXTURE_ROOT,
      activeWorkstreamIds: [],
      activeTaskIds: [],
      acceptedDecisionIds: [],
      ruleIds: [],
    },
  });
}

function taskEvent(
  id: string,
  status: 'todo' | 'in_progress' | 'blocked' | 'handoff_ready' | 'done',
  updatedAt: string,
): DomainEvent {
  return makeEvent({
    id: `evt_${id}`,
    type: 'task.created',
    scopeType: 'task',
    scopeId: id,
    payload: {
      id,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt,
      projectId: 'proj_1',
      title: id,
      description: id,
      status,
      priority: 'medium',
      ownerType: 'unassigned',
      goal: id,
      acceptanceCriteria: [],
      dependsOn: [],
      contextRefIds: [],
      decisionRefIds: [],
      ruleRefIds: [],
      openQuestions: [],
      riskNotes: [],
    },
  });
}

function workstreamEvent(
  id: string,
  status: 'active' | 'paused' | 'closed',
): DomainEvent {
  return makeEvent({
    id: `evt_${id}`,
    type: 'workstream.created',
    scopeType: 'workstream',
    scopeId: id,
    payload: {
      id,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:00:00.000Z',
      projectId: 'proj_1',
      title: id,
      summary: id,
      status,
    },
  });
}

function sessionStartedEvent(
  id: string,
  actor: string,
  taskId: string | undefined,
  startedAt: string,
): DomainEvent {
  return makeEvent({
    id: `evt_${id}_started`,
    type: 'session.started',
    scopeType: 'session',
    scopeId: id,
    actor,
    payload: {
      id,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: startedAt,
      updatedAt: startedAt,
      projectId: 'proj_1',
      ...(taskId ? { taskId } : {}),
      actor,
      startedAt,
      lastSeenAt: startedAt,
      status: 'active',
    },
  });
}

function sessionCompletedEvent(id: string, endedAt: string): DomainEvent {
  return makeEvent({
    id: `evt_${id}_completed`,
    type: 'session.completed',
    scopeType: 'session',
    scopeId: id,
    createdAt: endedAt,
    updatedAt: endedAt,
    payload: {},
  });
}

function sessionHeartbeatEvent(sessionId: string, at: string): DomainEvent {
  return makeEvent({
    id: `evt_${sessionId}_heartbeat_${at}`,
    type: 'session.heartbeat',
    scopeType: 'session',
    scopeId: sessionId,
    createdAt: at,
    updatedAt: at,
    payload: { sessionId, at },
  });
}

function decisionEvent(
  id: string,
  status: 'proposed' | 'accepted' | 'superseded' | 'rejected',
  updatedAt: string,
): DomainEvent {
  return makeEvent({
    id: `evt_${id}`,
    type: status === 'accepted' ? 'decision.accepted' : 'decision.proposed',
    scopeType: 'project',
    scopeId: id,
    payload: {
      id,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt,
      scopeType: 'project',
      scopeId: 'proj_1',
      title: id,
      decision: id,
      rationale: id,
      status,
      relatedRuleIds: [],
      createdBy: 'user',
    },
  });
}
