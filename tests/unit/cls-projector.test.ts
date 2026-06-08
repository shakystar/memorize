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

// Build a memory with a controlled id + createdAt for deterministic dedup.
function mem(
  id: string,
  createdAt: string,
  sourceObservationIds: string[],
  text = 'distilled',
) {
  return {
    ...createConsolidatedMemory({
      projectId,
      kind: 'progress',
      text,
      salience: 5,
      sourceObservationIds,
    }),
    id,
    createdAt,
  };
}

describe('projector — cross-machine duplicate dedup (P3-a)', () => {
  it('collapses memories with the same sourceObservationIds to one (createdAt,id) winner', () => {
    const winner = mem('mem_aaa', ts, ['obs_x', 'obs_y'], 'A');
    // Same source set, different order + later createdAt → loser.
    const loser = mem('mem_bbb', tsLater, ['obs_y', 'obs_x'], 'B');

    const state = reduceProjectState([
      evt({ id: 'evt_m1', type: 'memory.consolidated', payload: winner }),
      evt({ id: 'evt_m2', type: 'memory.consolidated', payload: loser }),
    ]);

    expect(state.memories[winner.id]!.invalidAt).toBeUndefined();
    expect(state.memories[winner.id]!.dedupedBy).toBeUndefined();
    expect(state.memories[loser.id]!.invalidAt).toBe(winner.createdAt);
    expect(state.memories[loser.id]!.dedupedBy).toBe(winner.id);
  });

  it('does NOT group memories with empty/absent sourceObservationIds', () => {
    const m1 = mem('mem_e1', ts, []);
    const m2 = mem('mem_e2', tsLater, []);
    const state = reduceProjectState([
      evt({ id: 'evt_m1', type: 'memory.consolidated', payload: m1 }),
      evt({ id: 'evt_m2', type: 'memory.consolidated', payload: m2 }),
    ]);
    expect(state.memories[m1.id]!.invalidAt).toBeUndefined();
    expect(state.memories[m2.id]!.invalidAt).toBeUndefined();
  });

  it('a genuinely superseded winner frees the former dedup loser', () => {
    const winner = mem('mem_w', ts, ['obs_x']);
    const dup = mem('mem_d', tsLater, ['obs_x']);
    const replacement = mem('mem_r', tsLater, ['obs_z'], 'reversed');
    const state = reduceProjectState([
      evt({ id: 'evt_w', type: 'memory.consolidated', payload: winner }),
      evt({ id: 'evt_d', type: 'memory.consolidated', payload: dup }),
      evt({ id: 'evt_r', type: 'memory.consolidated', payload: replacement }),
      evt({
        id: 'evt_s',
        type: 'memory.superseded',
        createdAt: tsLater,
        payload: {
          supersedes: winner.id,
          supersededBy: replacement.id,
          reason: 'reversed',
        },
      }),
    ]);
    // Winner is superseded (event), so it is skipped by dedup and the former
    // duplicate is no longer collapsed → it stays valid.
    expect(state.memories[winner.id]!.supersededBy).toBe(replacement.id);
    expect(state.memories[dup.id]!.invalidAt).toBeUndefined();
    expect(state.memories[dup.id]!.dedupedBy).toBeUndefined();
  });

  it('a superseded duplicate stays invalid via supersededBy, not dedupedBy', () => {
    const winner = mem('mem_w', ts, ['obs_x']);
    const dup = mem('mem_d', tsLater, ['obs_x']);
    const state = reduceProjectState([
      evt({ id: 'evt_w', type: 'memory.consolidated', payload: winner }),
      evt({ id: 'evt_d', type: 'memory.consolidated', payload: dup }),
      evt({
        id: 'evt_s',
        type: 'memory.superseded',
        createdAt: tsLater,
        payload: { supersedes: dup.id, supersededBy: 'mem_other', reason: 'x' },
      }),
    ]);
    expect(state.memories[dup.id]!.supersededBy).toBe('mem_other');
    expect(state.memories[dup.id]!.dedupedBy).toBeUndefined();
    expect(state.memories[winner.id]!.invalidAt).toBeUndefined();
  });
});
