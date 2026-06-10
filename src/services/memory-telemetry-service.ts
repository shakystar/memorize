import type { MemorySupersededPayload } from '../domain/entities.js';
import { getDb } from '../storage/db.js';
import { readEvents } from '../storage/event-store.js';
import { SEMANTIC_CONTRADICTION_REASON_PREFIX } from './contradiction-service.js';

/**
 * #62 — behavioral lifecycle telemetry for consolidated memories: what
 * actually HAPPENED to each memory after it existed (injected, superseded,
 * contradicted, deduped, age at invalidation). The behavioral half of the
 * #57 evidence (extraction-side predictions live on the memory itself);
 * jointly they answer whether different kinds invalidate on different
 * curves (discussion #61). Read-only over the projection + event log — no
 * consumer behavior changes.
 */

export interface MemoryLifecycleRow {
  id: string;
  kind: string;
  createdAt: string;
  /** Startup + mid-session live-share injections (best-effort counter). */
  injectionCount: number;
  /** Last startup-injection reinforcement stamp, when any. */
  lastAccessedAt?: string;
  invalidAt?: string;
  supersededBy?: string;
  dedupedBy?: string;
  /** From the memory.superseded event, when one closed this memory. */
  supersededAt?: string;
  supersededReason?: string;
  /** True when the supersession came from semantic contradiction detection. */
  contradicted: boolean;
  /** createdAt → invalidAt, in days (2 decimals). Absent while valid. */
  ageAtInvalidationDays?: number;
}

export interface MemoryBehaviorKindReport {
  count: number;
  /** Memories injected at least once / total injections across them. */
  injectedMemories: number;
  totalInjections: number;
  superseded: number;
  contradicted: number;
  deduped: number;
  /** Sorted ages (days) of every invalidated memory of this kind. */
  ageAtInvalidationDays: number[];
}

export interface MemoryBehaviorReport {
  memories: number;
  byKind: Record<string, MemoryBehaviorKindReport>;
}

function ageInDays(createdAt: string, invalidAt: string): number {
  const ms = Math.max(0, Date.parse(invalidAt) - Date.parse(createdAt));
  return Math.round((ms / 86_400_000) * 100) / 100;
}

/**
 * Per-memory lifecycle view: projection columns (validity window, counters)
 * joined with the `memory.superseded` events that closed them (timestamps +
 * reasons — the projection keeps only the ids).
 */
export async function listMemoryLifecycle(
  projectId: string,
): Promise<MemoryLifecycleRow[]> {
  const supersededById = new Map<string, { at: string; reason: string }>();
  for (const event of await readEvents(projectId)) {
    if (event.type !== 'memory.superseded') continue;
    const payload = event.payload as MemorySupersededPayload;
    supersededById.set(payload.supersedes, {
      at: event.createdAt,
      reason: payload.reason,
    });
  }

  const rows = getDb(projectId)
    .prepare(
      'SELECT id, kind, created_at, invalid_at, superseded_by, deduped_by, ' +
        'last_accessed_at, injection_count FROM memories ORDER BY created_at',
    )
    .all() as Array<{
    id: string;
    kind: string;
    created_at: string;
    invalid_at: string | null;
    superseded_by: string | null;
    deduped_by: string | null;
    last_accessed_at: string | null;
    injection_count: number;
  }>;

  return rows.map((row) => {
    const superseded = supersededById.get(row.id);
    return {
      id: row.id,
      kind: row.kind,
      createdAt: row.created_at,
      injectionCount: row.injection_count,
      ...(row.last_accessed_at ? { lastAccessedAt: row.last_accessed_at } : {}),
      ...(row.invalid_at ? { invalidAt: row.invalid_at } : {}),
      ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
      ...(row.deduped_by ? { dedupedBy: row.deduped_by } : {}),
      ...(superseded ? { supersededAt: superseded.at } : {}),
      ...(superseded ? { supersededReason: superseded.reason } : {}),
      contradicted: Boolean(
        superseded?.reason.startsWith(SEMANTIC_CONTRADICTION_REASON_PREFIX),
      ),
      ...(row.invalid_at
        ? { ageAtInvalidationDays: ageInDays(row.created_at, row.invalid_at) }
        : {}),
    };
  });
}

/** Aggregate the per-memory rows into the kind × behavior distribution. */
export async function buildMemoryBehaviorReport(
  projectId: string,
): Promise<MemoryBehaviorReport> {
  const rows = await listMemoryLifecycle(projectId);
  const report: MemoryBehaviorReport = { memories: rows.length, byKind: {} };
  for (const row of rows) {
    const bucket = (report.byKind[row.kind] ??= {
      count: 0,
      injectedMemories: 0,
      totalInjections: 0,
      superseded: 0,
      contradicted: 0,
      deduped: 0,
      ageAtInvalidationDays: [],
    });
    bucket.count += 1;
    if (row.injectionCount > 0) {
      bucket.injectedMemories += 1;
      bucket.totalInjections += row.injectionCount;
    }
    if (row.supersededBy) bucket.superseded += 1;
    if (row.contradicted) bucket.contradicted += 1;
    if (row.dedupedBy) bucket.deduped += 1;
    if (row.ageAtInvalidationDays !== undefined) {
      bucket.ageAtInvalidationDays.push(row.ageAtInvalidationDays);
    }
  }
  for (const bucket of Object.values(report.byKind)) {
    bucket.ageAtInvalidationDays.sort((a, b) => a - b);
  }
  return report;
}
