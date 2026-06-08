import type { ConsolidatedMemoryKind, ObservationSignal } from './memory.js';

/**
 * CLS Phase 2 — real-time share payload (transport DTO).
 *
 * The channel-agnostic shape the realtime-share service builds from the event
 * delta and an adapter renders into `additionalContext`. Lives in domain (like
 * StartupContextPayload) so both the service that builds it and the adapters
 * that render it depend on the type without an adapters→services edge.
 */

export interface SiblingObservationItem {
  sessionId: string;
  actor: string;
  signal: ObservationSignal;
  toolName?: string;
  summary?: string;
  createdAt: string;
}

export interface SiblingMemoryItem {
  kind: ConsolidatedMemoryKind;
  text: string;
  salience: number;
  sessionId?: string;
  actor: string;
  createdAt: string;
}

export interface FileConflictWarning {
  filePath: string;
  siblingSessionId: string;
  siblingActor: string;
  siblingSummary?: string;
}

export interface LiveUpdate {
  observations: SiblingObservationItem[];
  memories: SiblingMemoryItem[];
  conflicts: FileConflictWarning[];
  /** Highest event id covered by this delta — becomes the new watermark AFTER
   *  delivery (advances over the whole scanned window, including capped/dropped
   *  items, so nothing is ever re-read → no duplicate injection). */
  newWatermarkEventId: string | undefined;
  /** True only when at least one array is non-empty after self-filtering. */
  hasContent: boolean;
}
