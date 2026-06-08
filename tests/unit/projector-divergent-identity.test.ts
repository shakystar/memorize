import { describe, expect, it } from 'vitest';

import type { DomainEvent } from '../../src/domain/events.js';
import { reduceProjectState } from '../../src/projections/projector.js';

const ts = '2026-06-08T00:00:00.000Z';

function projectCreated(projectId: string, eventId: string): DomainEvent {
  return {
    id: eventId,
    schemaVersion: '0.1.0',
    createdAt: ts,
    updatedAt: ts,
    type: 'project.created',
    projectId,
    scopeType: 'project',
    scopeId: projectId,
    actor: 'test',
    payload: { id: projectId } as never,
  };
}

describe('projector — divergent project identity guard (#30)', () => {
  it('throws when two distinct project.created ids appear in one log', () => {
    const events = [
      projectCreated('proj_a', 'evt_1'),
      projectCreated('proj_b', 'evt_2'),
    ];
    expect(() => reduceProjectState(events)).toThrow(/Divergent project identity/);
  });

  it('allows the SAME project.created id repeated (idempotent re-pull)', () => {
    const events = [
      projectCreated('proj_a', 'evt_1'),
      projectCreated('proj_a', 'evt_1'),
    ];
    const state = reduceProjectState(events);
    expect(state.project?.id).toBe('proj_a');
  });
});
