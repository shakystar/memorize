import { describe, expect, it } from 'vitest';

import {
  assertConflictStatusTransition,
  assertSessionStatusTransition,
  assertSyncStatusTransition,
  assertTaskStatusTransition,
  assertWorkstreamStatusTransition,
} from '../../src/domain/state-machines.js';

describe('domain state machines', () => {
  it('allows valid task transitions', () => {
    expect(() =>
      assertTaskStatusTransition('todo', 'in_progress'),
    ).not.toThrow();
    expect(() =>
      assertTaskStatusTransition('handoff_ready', 'done'),
    ).not.toThrow();
  });

  it('rejects invalid task transitions', () => {
    expect(() => assertTaskStatusTransition('todo', 'done')).toThrow(
      /invalid task status transition/i,
    );
    expect(() =>
      assertTaskStatusTransition('done', 'in_progress'),
    ).toThrow(/invalid task status transition/i);
  });

  it('allows valid workstream transitions', () => {
    expect(() =>
      assertWorkstreamStatusTransition('active', 'paused'),
    ).not.toThrow();
    expect(() =>
      assertWorkstreamStatusTransition('paused', 'closed'),
    ).not.toThrow();
  });

  it('rejects invalid workstream transitions', () => {
    expect(() =>
      assertWorkstreamStatusTransition('closed', 'active'),
    ).toThrow(/invalid workstream status transition/i);
  });

  it('enforces session transitions', () => {
    expect(() =>
      assertSessionStatusTransition('active', 'completed'),
    ).not.toThrow();
    expect(() =>
      assertSessionStatusTransition('completed', 'active'),
    ).toThrow(/invalid session status transition/i);
  });

  it('enforces conflict transitions', () => {
    expect(() =>
      assertConflictStatusTransition('detected', 'escalated'),
    ).not.toThrow();
    expect(() =>
      assertConflictStatusTransition('resolved', 'detected'),
    ).toThrow(/invalid conflict status transition/i);
  });

  it('enforces sync transitions', () => {
    expect(() =>
      assertSyncStatusTransition('idle', 'syncing'),
    ).not.toThrow();
    expect(() =>
      assertSyncStatusTransition('idle', 'conflicted'),
    ).toThrow(/invalid sync status transition/i);
  });
});
