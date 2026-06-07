import { describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../src/domain/common.js';
import {
  createConsolidatedMemory,
  createObservation,
} from '../../src/domain/entities.js';
import type { DomainEvent } from '../../src/domain/events.js';
import { reduceProjectState } from '../../src/projections/projector.js';

const projectId = 'proj_clsproj_test1';
const ts = '2026-06-08T00:00:00.000Z';
const tsLater = '2026-06-08T01:00:00.000Z';

function evt(
  overrides: Partial<DomainEvent> & Pick<DomainEvent, 'id' | 'type' | 'payload'>,
): DomainEvent {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: ts,
    updatedAt: ts,
    projectId,
    scopeType: 'session',
    scopeId: 'sess_1',
    actor: 'claude',
    ...overrides,
  } as DomainEvent;
}

describe('projector — CLS events', () => {
  it('reduces observation.captured and memory.consolidated into state', () => {
    const observation = createObservation({
      projectId,
      signal: 'write-tool',
      toolName: 'Write',
      summary: 'Write: /repo/a.ts',
    });
    const memory = createConsolidatedMemory({
      projectId,
      kind: 'decision',
      text: 'Use sqlite for storage',
      salience: 8,
      sourceObservationIds: [observation.id],
    });

    const state = reduceProjectState([
      evt({ id: 'evt_o1', type: 'observation.captured', payload: observation }),
      evt({ id: 'evt_m1', type: 'memory.consolidated', payload: memory }),
    ]);

    expect(state.observations[observation.id]).toEqual(observation);
    expect(state.memories[memory.id]).toEqual(memory);
    expect(state.memories[memory.id]!.invalidAt).toBeUndefined();
  });

  it('memory.superseded closes the validity window without deleting (bi-temporal D4)', () => {
    const oldMemory = createConsolidatedMemory({
      projectId,
      kind: 'decision',
      text: 'Use postgres',
      salience: 7,
    });
    const newMemory = createConsolidatedMemory({
      projectId,
      kind: 'decision',
      text: 'Use sqlite instead of postgres',
      salience: 8,
    });

    const state = reduceProjectState([
      evt({ id: 'evt_m1', type: 'memory.consolidated', payload: oldMemory }),
      evt({ id: 'evt_m2', type: 'memory.consolidated', payload: newMemory }),
      evt({
        id: 'evt_s1',
        type: 'memory.superseded',
        createdAt: tsLater,
        payload: {
          supersedes: oldMemory.id,
          supersededBy: newMemory.id,
          reason: 'Storage decision reversed',
        },
      }),
    ]);

    // The old memory is still there — invalidated, not deleted.
    const superseded = state.memories[oldMemory.id]!;
    expect(superseded.text).toBe('Use postgres');
    expect(superseded.invalidAt).toBe(tsLater);
    expect(superseded.supersededBy).toBe(newMemory.id);
    // The new memory is open-ended.
    expect(state.memories[newMemory.id]!.invalidAt).toBeUndefined();
  });

  it('memory.superseded for an unknown id is a safe no-op', () => {
    const state = reduceProjectState([
      evt({
        id: 'evt_s1',
        type: 'memory.superseded',
        payload: {
          supersedes: 'mem_ghost',
          supersededBy: 'mem_other',
          reason: 'n/a',
        },
      }),
    ]);
    expect(Object.keys(state.memories)).toHaveLength(0);
  });
});
