import { nowIso } from '../domain/common.js';
import type { Conflict } from '../domain/entities.js';
import { assertConflictStatusTransition } from '../domain/state-machines.js';
import { MemorizeError } from '../shared/errors.js';
import { appendEvent } from '../storage/event-store.js';
import { getConflict, rebuildProjectProjection } from './projection-store.js';

/**
 * Move an open conflict to `resolved`, emitting `conflict.resolved`. Mirrors
 * updateTask (task-service): read current state, enforce the state-machine
 * transition guard, then append the event with the full updated entity so the
 * projector (which replaces state.conflicts[id] wholesale) reflects it and the
 * open-conflict query (`status != 'resolved'`) drops it.
 *
 * MVP: manual `resolved` only. `auto_resolved` / `escalated` producers are
 * deferred (no caller models automated arbitration yet).
 */
export async function resolveConflict(
  projectId: string,
  conflictId: string,
  opts: { actor: string; summary?: string },
): Promise<Conflict> {
  const existing = await readConflict(projectId, conflictId);
  if (!existing) {
    throw new MemorizeError(
      `Conflict ${conflictId} not found in project ${projectId}`,
    );
  }
  assertConflictStatusTransition(existing.status, 'resolved');

  const resolved: Conflict = {
    ...existing,
    status: 'resolved',
    resolvedBy: opts.actor,
    resolvedAt: nowIso(),
    updatedAt: nowIso(),
    ...(opts.summary ? { resolutionSummary: opts.summary } : {}),
  };
  await appendEvent({
    type: 'conflict.resolved',
    projectId,
    scopeType: 'project',
    scopeId: conflictId,
    actor: opts.actor,
    payload: resolved,
  });
  await rebuildProjectProjection(projectId);
  return resolved;
}

export async function readConflict(
  projectId: string,
  conflictId: string,
): Promise<Conflict | undefined> {
  return getConflict(projectId, conflictId);
}
