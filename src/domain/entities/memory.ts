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
  /**
   * Structured file path for write-tool observations (raw, un-clipped) — set
   * so Phase 2 live sharing can detect cross-session file collisions without
   * re-parsing the possibly-truncated `summary`. Absent for Bash signals and
   * for legacy rows captured before this field existed (readers fall back to
   * parsing `summary`).
   */
  filePath?: string;
  /** Transcript locator for the boundary consolidator (hybrid ownership, D2). */
  transcriptPath?: string;
  /** Upstream agent conversation id, when the hook payload exposes one. */
  agentSessionId?: string;
  /** Cursor conversation id, used only as provenance/idempotency metadata. */
  conversationId?: string;
  /** Cursor generation id, used only as provenance/idempotency metadata. */
  generationId?: string;
  /** Upstream tool call id, used to dedupe dual-source Cursor hooks. */
  toolUseId?: string;
}

export function createObservation(input: {
  projectId: string;
  signal: ObservationSignal;
  sessionId?: string;
  toolName?: string;
  summary?: string;
  filePath?: string;
  transcriptPath?: string;
  agentSessionId?: string;
  conversationId?: string;
  generationId?: string;
  toolUseId?: string;
}): Observation {
  return {
    ...baseEntity('obs'),
    projectId: input.projectId,
    signal: input.signal,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.toolName ? { toolName: input.toolName } : {}),
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.filePath ? { filePath: input.filePath } : {}),
    ...(input.transcriptPath ? { transcriptPath: input.transcriptPath } : {}),
    ...(input.agentSessionId ? { agentSessionId: input.agentSessionId } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.generationId ? { generationId: input.generationId } : {}),
    ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
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
  /**
   * #57 observe-only lifecycle evidence (discussion #61). Emitted by the
   * extractor, persisted, and read by NO consumer — injection, dedup, and
   * contradiction detection keep keying on `kind`. Pure instrumentation to
   * decide later whether the kind enum should become named lifecycle
   * policies. All optional; absence is the common case.
   */
  /** Free-form condition after which this memory stops being true. */
  obsoleteWhen?: string;
  /** Extractor judged that none of the three kinds fits this item. */
  kindMisfit?: boolean;
  kindMisfitReason?: string;
  /** Free-form replacement note when no listed memory id could be pinned. */
  supersedesNote?: string;
  /** 1–3 free-form lowercase tags — the extractor's own vocabulary. */
  tags?: string[];
  /**
   * #69 — provenance label when this memory was ingested via
   * `memorize memory import` (agent-distilled harness memory, docs, …)
   * instead of boundary consolidation. Absent for consolidated memories.
   */
  importSource?: string;
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
  obsoleteWhen?: string;
  kindMisfit?: boolean;
  kindMisfitReason?: string;
  supersedesNote?: string;
  tags?: string[];
  importSource?: string;
}): ConsolidatedMemory {
  return {
    ...baseEntity('mem'),
    projectId: input.projectId,
    kind: input.kind,
    text: input.text,
    salience: clampSalience(input.salience),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    sourceObservationIds: input.sourceObservationIds ?? [],
    ...(input.obsoleteWhen ? { obsoleteWhen: input.obsoleteWhen } : {}),
    ...(input.kindMisfit ? { kindMisfit: true } : {}),
    ...(input.kindMisfitReason ? { kindMisfitReason: input.kindMisfitReason } : {}),
    ...(input.supersedesNote ? { supersedesNote: input.supersedesNote } : {}),
    ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
    ...(input.importSource ? { importSource: input.importSource } : {}),
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

/**
 * Retraction = tombstone (SoT-050). A retraction removes a memory with NO
 * replacement — an explicit "forget this", distinct from supersede (which
 * closes the window because a newer memory replaces it). It closes the
 * memory's validity window the same way, but carries no `supersededBy` and a
 * separate `retractedAt` marker so it is (a) reversible via a later
 * retract-the-retraction event and (b) distinguishable in audit. Provenance
 * (`writer`/`sourceProjectId`) rides the DomainEvent, not this payload.
 */
export interface MemoryRetractedPayload {
  /** The memory whose validity window this event closes. */
  retracts: EntityId;
  /** Why it was retracted (free-form, optional). */
  reason?: string;
  /**
   * The retractor's workspace role AT AUTHORING TIME (W-c, SoT-050/022, Hub
   * H030). Stamped by the client only for a cross-lane (GLOBAL) retract, after
   * verifying its role against the Hub control-plane; absent on a plain
   * self-lane retract. The projection honours a cross-lane retract iff this is
   * `'owner'`. The role must ride the EVENT, not be looked up at projection
   * time: (a) the reducer stays a pure function of the log, so every replica
   * converges regardless of when its role cache last refreshed and a later
   * demotion never retroactively flips history, and (b) a roster lookup is
   * impossible anyway — the roster is accountId-keyed and events carry only
   * `writer`/`sourceProjectId` (the gateway never sees either, H010). Like all
   * union bytes it is a trusted-membership claim, not a cryptographic proof
   * (H030's accepted trade-off).
   */
  writerRole?: 'owner' | 'member';
}
