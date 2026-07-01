import { getDb } from '../storage/db.js';

/**
 * Read/write the `segments` table (v10) — a DERIVED, bounded short-term buffer of
 * raw transcript content, chunked at turn boundaries. It makes the original
 * conversation retrievable alongside the (lossy) consolidated memories: a memory
 * is the compressed gist, a segment preserves the verbatim detail consolidation
 * dropped. Maintained out-of-band by `consolidate()` (insert) + `pruneSegments`
 * (retention), indexed into search_fts/embeddings under kind='segment'. Like
 * `embeddings` this is NOT rebuilt by rebuildProjectProjection and is lost on a
 * true from-scratch replay (re-accumulated on the next consolidation).
 */

export interface SegmentRow {
  id: string;
  sessionId?: string;
  createdAt: string;
  ordinal: number;
  source?: string;
  text: string;
  /**
   * Origin store lane (M2 `(entity, writer)` projection). Undefined = self.
   * Locally-captured segments are always self; a non-self value would arrive
   * only via a workspace union (W3). Kept out of FTS folding via the mirrored
   * `search_fts.source_project_id`. See docs/SoT/040.
   */
  sourceProjectId?: string;
}

interface RawRow {
  id: string;
  session_id: string | null;
  created_at: string;
  ordinal: number | null;
  source: string | null;
  source_project_id: string | null;
  text: string;
}

function parseRow(r: RawRow): SegmentRow {
  return {
    id: r.id,
    ...(r.session_id ? { sessionId: r.session_id } : {}),
    createdAt: r.created_at,
    ordinal: r.ordinal ?? 0,
    ...(r.source ? { source: r.source } : {}),
    ...(r.source_project_id ? { sourceProjectId: r.source_project_id } : {}),
    text: r.text,
  };
}

/** Bulk-insert segments for one consolidation boundary (single transaction). */
export function insertSegments(projectId: string, rows: SegmentRow[]): void {
  if (rows.length === 0) return;
  const db = getDb(projectId);
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO segments (id, session_id, created_at, ordinal, source, source_project_id, text)
     VALUES (@id, @sessionId, @createdAt, @ordinal, @source, @sourceProjectId, @text)`,
  );
  const tx = db.transaction((batch: SegmentRow[]) => {
    for (const s of batch) {
      stmt.run({
        id: s.id,
        sessionId: s.sessionId ?? null,
        createdAt: s.createdAt,
        ordinal: s.ordinal,
        source: s.source ?? null,
        sourceProjectId: s.sourceProjectId ?? null,
        text: s.text,
      });
    }
  });
  tx(rows);
}

/** All segments, newest first. Used for FTS rebuild and embedding. */
export function listSegments(projectId: string): SegmentRow[] {
  const rows = getDb(projectId)
    .prepare(
      'SELECT id, session_id, created_at, ordinal, source, source_project_id, text FROM segments ORDER BY created_at DESC, ordinal ASC',
    )
    .all() as RawRow[];
  return rows.map(parseRow);
}

/** Map of segment id -> text, for hydrating search hits (text isn't in the projection). */
export function listSegmentTexts(projectId: string): Map<string, string> {
  const rows = getDb(projectId)
    .prepare('SELECT id, text FROM segments')
    .all() as Array<{ id: string; text: string }>;
  return new Map(rows.map((r) => [r.id, r.text]));
}

export interface PruneOptions {
  /** Delete segments older than this many days. */
  maxAgeDays?: number;
  /** After age pruning, if more than this remain, drop the oldest beyond the cap. */
  maxCount?: number;
  /** Clock injection for tests; defaults to Date.now(). */
  nowMs?: number;
}

export const SEGMENT_RETENTION_DAYS = 30;
export const SEGMENT_RETENTION_MAX = 2000;

/**
 * Retention: keep segments to a rolling window so the buffer stays bounded (it is
 * NOT a permanent store — that would defeat consolidation's compression). Deletes
 * by age then by count (oldest first), and removes the matching kind='segment'
 * embedding rows so the two derived tables stay consistent. Returns deleted ids
 * (so the caller could reconcile FTS, though a rebuild does that anyway).
 */
export function pruneSegments(projectId: string, opts: PruneOptions = {}): string[] {
  const db = getDb(projectId);
  const maxAgeDays = opts.maxAgeDays ?? SEGMENT_RETENTION_DAYS;
  const maxCount = opts.maxCount ?? SEGMENT_RETENTION_MAX;
  const nowMs = opts.nowMs ?? Date.now();
  const cutoffIso = new Date(nowMs - maxAgeDays * 86_400_000).toISOString();

  const deleted: string[] = [];
  const aged = db
    .prepare('SELECT id FROM segments WHERE created_at < ?')
    .all(cutoffIso) as Array<{ id: string }>;
  for (const r of aged) deleted.push(r.id);

  // Over-cap: oldest beyond maxCount (counting only those not already aged out).
  const survivors = db
    .prepare(
      'SELECT id FROM segments WHERE created_at >= ? ORDER BY created_at DESC, ordinal ASC',
    )
    .all(cutoffIso) as Array<{ id: string }>;
  if (survivors.length > maxCount) {
    for (const r of survivors.slice(maxCount)) deleted.push(r.id);
  }

  if (deleted.length === 0) return [];
  const delSeg = db.prepare('DELETE FROM segments WHERE id = ?');
  const delEmb = db.prepare('DELETE FROM embeddings WHERE entity_id = ?');
  const tx = db.transaction((ids: string[]) => {
    for (const id of ids) {
      delSeg.run(id);
      delEmb.run(id);
    }
  });
  tx(deleted);
  return deleted;
}
