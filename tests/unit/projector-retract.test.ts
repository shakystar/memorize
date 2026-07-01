import { describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../src/domain/common.js';
import { createConsolidatedMemory } from '../../src/domain/entities.js';
import type { DomainEvent } from '../../src/domain/events.js';
import { reduceProjectState } from '../../src/projections/projector.js';

const projectId = 'proj_retract_test1';
const ts = '2026-07-01T00:00:00.000Z';
const tsLater = '2026-07-01T01:00:00.000Z';
const tsLater2 = '2026-07-01T02:00:00.000Z';

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

function mem(text = 'Use sqlite for storage') {
  return createConsolidatedMemory({
    projectId,
    kind: 'decision',
    text,
    salience: 8,
    sourceObservationIds: ['obs_x'],
  });
}

describe('projector — memory.retracted (tombstone, SoT-050)', () => {
  it('closes the validity window without deleting and stamps retractedAt/By', () => {
    const memory = mem();
    const state = reduceProjectState([
      evt({ id: 'evt_m1', type: 'memory.consolidated', payload: memory }),
      evt({
        id: 'evt_r1',
        type: 'memory.retracted',
        createdAt: tsLater,
        writer: 'alice',
        payload: { retracts: memory.id, reason: 'no longer accurate' },
      }),
    ]);

    const retracted = state.memories[memory.id]!;
    // Row preserved, text intact — invalidate-not-delete.
    expect(retracted.text).toBe('Use sqlite for storage');
    expect(retracted.invalidAt).toBe(tsLater);
    expect(retracted.retractedAt).toBe(tsLater);
    expect(retracted.retractedBy).toBe('alice');
    // No replacement, unlike supersede.
    expect(retracted.supersededBy).toBeUndefined();
  });

  it('retract of an unknown id is a safe no-op', () => {
    const state = reduceProjectState([
      evt({
        id: 'evt_r1',
        type: 'memory.retracted',
        payload: { retracts: 'mem_ghost' },
      }),
    ]);
    expect(Object.keys(state.memories)).toHaveLength(0);
  });

  it('retracting an already-superseded memory keeps the earlier window but marks it retracted', () => {
    const memory = mem();
    const replacement = mem('Use postgres instead');
    const state = reduceProjectState([
      evt({ id: 'evt_m1', type: 'memory.consolidated', payload: memory }),
      evt({ id: 'evt_m2', type: 'memory.consolidated', payload: replacement }),
      evt({
        id: 'evt_s1',
        type: 'memory.superseded',
        createdAt: tsLater,
        payload: {
          supersedes: memory.id,
          supersededBy: replacement.id,
          reason: 'reversed',
        },
      }),
      evt({
        id: 'evt_r1',
        type: 'memory.retracted',
        createdAt: tsLater2,
        payload: { retracts: memory.id },
      }),
    ]);

    const row = state.memories[memory.id]!;
    // Window stays closed at the earlier supersede (point-in-time), and both
    // markers coexist.
    expect(row.invalidAt).toBe(tsLater);
    expect(row.supersededBy).toBe(replacement.id);
    expect(row.retractedAt).toBe(tsLater2);
  });

  it('replaying the same retract event is idempotent', () => {
    const memory = mem();
    const retract = evt({
      id: 'evt_r1',
      type: 'memory.retracted',
      createdAt: tsLater,
      writer: 'alice',
      payload: { retracts: memory.id },
    });
    const once = reduceProjectState([
      evt({ id: 'evt_m1', type: 'memory.consolidated', payload: memory }),
      retract,
    ]);
    const twice = reduceProjectState([
      evt({ id: 'evt_m1', type: 'memory.consolidated', payload: memory }),
      retract,
      retract,
    ]);
    expect(twice.memories[memory.id]).toEqual(once.memories[memory.id]);
  });
});

describe('projector — memory.retracted lane guard (SoT-040/H030)', () => {
  it('a foreign-lane retract does NOT retract a self memory', () => {
    const memory = mem(); // self lane (event has no sourceProjectId)
    const state = reduceProjectState([
      evt({ id: 'evt_m1', type: 'memory.consolidated', payload: memory }),
      evt({
        id: 'evt_r1',
        type: 'memory.retracted',
        createdAt: tsLater,
        sourceProjectId: 'proj_foreign',
        payload: { retracts: memory.id },
      }),
    ]);
    // Cross-lane retract is deferred to the W3 owner-role gate → no-op here.
    expect(state.memories[memory.id]!.invalidAt).toBeUndefined();
    expect(state.memories[memory.id]!.retractedAt).toBeUndefined();
  });

  it('a self retract does NOT retract a foreign-lane memory', () => {
    const memory = mem();
    const state = reduceProjectState([
      evt({
        id: 'evt_m1',
        type: 'memory.consolidated',
        sourceProjectId: 'proj_foreign',
        payload: memory,
      }),
      evt({
        id: 'evt_r1',
        type: 'memory.retracted',
        createdAt: tsLater,
        payload: { retracts: memory.id },
      }),
    ]);
    const row = state.memories[memory.id]!;
    expect(row.sourceProjectId).toBe('proj_foreign');
    expect(row.invalidAt).toBeUndefined();
    expect(row.retractedAt).toBeUndefined();
  });

  it('a same-lane retract removes the foreign-lane memory', () => {
    const memory = mem();
    const state = reduceProjectState([
      evt({
        id: 'evt_m1',
        type: 'memory.consolidated',
        sourceProjectId: 'proj_foreign',
        payload: memory,
      }),
      evt({
        id: 'evt_r1',
        type: 'memory.retracted',
        createdAt: tsLater,
        writer: 'bob',
        sourceProjectId: 'proj_foreign',
        payload: { retracts: memory.id },
      }),
    ]);
    const row = state.memories[memory.id]!;
    expect(row.invalidAt).toBe(tsLater);
    expect(row.retractedAt).toBe(tsLater);
    expect(row.retractedBy).toBe('bob');
  });
});
