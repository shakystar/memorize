import type { BaseEntity, EntityId } from '../common.js';
import { baseEntity } from './base.js';

/**
 * CLS two-layer memory (Phase 1) — short-term layer.
 *
 * An Observation is a cheap, raw episodic capture taken DURING work (the
 * hippocampus analog): which tool fired, why the decision-signal filter let
 * it through, and a locator back into the agent transcript. No LLM is
 * involved at capture time — expensive semantic work is deferred entirely
 * to the consolidation boundary (decision D3; the rc.0..rc.4 per-turn
 * lesson).
 */

/** Which filter rule admitted this observation (capture-service). */
export type ObservationSignal =
  | 'write-tool'
  | 'mutating-bash'
  | 'decision-keyword'
  | 'task-transition';

export interface Observation extends BaseEntity {
  projectId: EntityId;
  /** memorize session the observation belongs to (when resolvable). */
  sessionId?: EntityId;
  /** Agent tool that fired (Write / Edit / Bash / ...). */
  toolName?: string;
  signal: ObservationSignal;
  /** Cheap rule-derived one-liner (file path, command head) — NOT an LLM summary. */
  summary?: string;
  /** Transcript locator for the boundary consolidator (hybrid ownership, D2). */
  transcriptPath?: string;
}

export function createObservation(input: {
  projectId: string;
  signal: ObservationSignal;
  sessionId?: string;
  toolName?: string;
  summary?: string;
  transcriptPath?: string;
}): Observation {
  return {
    ...baseEntity('obs'),
    projectId: input.projectId,
    signal: input.signal,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.toolName ? { toolName: input.toolName } : {}),
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.transcriptPath ? { transcriptPath: input.transcriptPath } : {}),
  };
}

/**
 * CLS two-layer memory (Phase 1) — long-term layer.
 *
 * A ConsolidatedMemory is a semantic unit (decision / rationale / progress)
 * extracted at a boundary (PostCompact / SessionEnd / SessionStart catch-up)
 * from the accumulated observations + transcript. It is appended as an event
 * like everything else — consolidation never mutates or deletes the raw
 * episodes it summarizes (invariant: append-only, forgetting without
 * deletion).
 */
export type ConsolidatedMemoryKind = 'decision' | 'rationale' | 'progress';

export const MIN_SALIENCE = 1;
export const MAX_SALIENCE = 10;

export interface ConsolidatedMemory extends BaseEntity {
  projectId: EntityId;
  kind: ConsolidatedMemoryKind;
  text: string;
  /** Importance 1–10, scored in the boundary batch (never at capture time). */
  salience: number;
  /** Session whose boundary produced this memory (when resolvable). */
  sessionId?: EntityId;
  /** Observations this memory was distilled from (provenance). */
  sourceObservationIds: EntityId[];
}

export function clampSalience(value: number): number {
  if (!Number.isFinite(value)) return MIN_SALIENCE;
  return Math.min(MAX_SALIENCE, Math.max(MIN_SALIENCE, Math.round(value)));
}

export function createConsolidatedMemory(input: {
  projectId: string;
  kind: ConsolidatedMemoryKind;
  text: string;
  salience: number;
  sessionId?: string;
  sourceObservationIds?: string[];
}): ConsolidatedMemory {
  return {
    ...baseEntity('mem'),
    projectId: input.projectId,
    kind: input.kind,
    text: input.text,
    salience: clampSalience(input.salience),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    sourceObservationIds: input.sourceObservationIds ?? [],
  };
}

/**
 * Conflict = invalidate-not-delete (D4). When consolidation finds a memory
 * contradicted by a newer one, it appends this event to close the old
 * memory's validity window. The original event (and row) is preserved so
 * "what was true then" remains reconstructable point-in-time.
 */
export interface MemorySupersededPayload {
  /** The memory whose validity window this event closes. */
  supersedes: EntityId;
  /** The newer memory that replaces it. */
  supersededBy: EntityId;
  reason: string;
}
