import { describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../src/domain/common.js';
import type { DomainEvent, DomainEventType } from '../../src/domain/events.js';
import { reduceProjectState } from '../../src/projections/projector.js';

const SELF = 'proj_self';
const HUB = 'proj_hub';

let seq = 0;
/** Minimal hand-built event; payload is caller-shaped (runtime cast). */
function mkEvent(
  type: DomainEventType,
  scopeId: string,
  payload: unknown,
  sourceProjectId: string,
): DomainEvent {
  seq += 1;
  const at = `2026-07-03T00:00:${String(seq).padStart(2, '0')}.000Z`;
  return {
    id: `evt_${seq}`,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: at,
    updatedAt: at,
    type,
    projectId: sourceProjectId,
    scopeType: 'project',
    scopeId,
    actor: 'test',
    writer: 'test',
    sourceProjectId,
    payload,
  } as DomainEvent;
}

function genesis(id: string, title: string): DomainEvent {
  return mkEvent('project.created', id, { id, title }, id);
}

const REQUEST = {
  id: 'taskreq_1',
  schemaVersion: CURRENT_SCHEMA_VERSION,
  createdAt: '2026-07-03T00:00:00.000Z',
  updatedAt: '2026-07-03T00:00:00.000Z',
  projectId: HUB,
  targetProjectId: SELF,
  title: 'Please add the sources roster',
  description: '',
  goal: '',
  acceptanceCriteria: [],
  status: 'pending',
};

describe('reduceProjectState — task requests (SoT-041)', () => {
  it('collects member projects from every genesis, flagging self', () => {
    const state = reduceProjectState([genesis(SELF, 'memorize'), genesis(HUB, 'memorize_hub')], SELF);
    expect(state.memberProjects[SELF]).toEqual({ id: SELF, title: 'memorize', isSelf: true });
    expect(state.memberProjects[HUB]).toEqual({ id: HUB, title: 'memorize_hub', isSelf: false });
  });

  it('keeps a foreign request pending in its own lane', () => {
    const state = reduceProjectState(
      [genesis(SELF, 'memorize'), genesis(HUB, 'memorize_hub'), mkEvent('task.requested', REQUEST.id, REQUEST, HUB)],
      SELF,
    );
    const requests = Object.values(state.taskRequests);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.status).toBe('pending');
    expect(requests[0]!.targetProjectId).toBe(SELF);
  });

  it('folds a self-lane accept into the foreign request (cross-lane resolution)', () => {
    const state = reduceProjectState(
      [
        genesis(SELF, 'memorize'),
        genesis(HUB, 'memorize_hub'),
        mkEvent('task.requested', REQUEST.id, REQUEST, HUB),
        mkEvent('task.request-accepted', REQUEST.id, { requestId: REQUEST.id, taskId: 'task_local_1' }, SELF),
      ],
      SELF,
    );
    const request = Object.values(state.taskRequests)[0]!;
    expect(request.status).toBe('accepted');
    expect(request.resolvedByTaskId).toBe('task_local_1');
  });

  it('folds a decline with its reason', () => {
    const state = reduceProjectState(
      [
        genesis(SELF, 'memorize'),
        genesis(HUB, 'memorize_hub'),
        mkEvent('task.requested', REQUEST.id, REQUEST, HUB),
        mkEvent('task.request-declined', REQUEST.id, { requestId: REQUEST.id, reason: 'already shipped in #238' }, SELF),
      ],
      SELF,
    );
    const request = Object.values(state.taskRequests)[0]!;
    expect(request.status).toBe('declined');
    expect(request.declineReason).toBe('already shipped in #238');
  });

  it('ignores an accept for an unknown request (tolerant reduce)', () => {
    const state = reduceProjectState(
      [genesis(SELF, 'memorize'), mkEvent('task.request-accepted', 'taskreq_ghost', { requestId: 'taskreq_ghost', taskId: 't' }, SELF)],
      SELF,
    );
    expect(Object.values(state.taskRequests)).toHaveLength(0);
  });
});
