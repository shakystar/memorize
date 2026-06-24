// scripts/benchmarks/retrieval/run.ts
import { reciprocalRankFusion } from '../../../src/services/embeddings-service.js';
import { semanticSearch } from '../../../src/services/search-service.js';
import { getDb } from '../../../src/storage/db.js';

import type { SeededQuestion } from './seed.js';

export type Mode = 'bm25' | 'hybrid';

/**
 * OR-of-tokens FTS5 MATCH — standard BM25 retrieval that ranks by term overlap,
 * unlike memorize's product `toFtsMatch` which ANDs all tokens (built for short
 * task-title probes, it returns 0 hits for a full question). Each token is
 * wrapped as an FTS5 string (double-quoted, embedded quotes doubled) so any
 * punctuation is literal and the input is injection-safe. Returns undefined when
 * the query has no searchable tokens.
 */
export function toOrMatch(query: string): string | undefined {
  const tokens = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => /[\p{L}\p{N}]/u.test(t));
  if (tokens.length === 0) return undefined;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

/** OR-BM25 lexical hits as entity ids, best-first (lower bm25 = more relevant). */
export function bm25EntityIds(
  projectId: string,
  query: string,
  limit: number,
): string[] {
  const match = toOrMatch(query);
  if (!match) return [];
  const rows = getDb(projectId)
    .prepare(
      `SELECT entity_id AS entityId
         FROM search_fts
        WHERE search_fts MATCH ?
        ORDER BY bm25(search_fts)
        LIMIT ?`,
    )
    .all(match, limit) as Array<{ entityId: string }>;
  return rows.map((r) => r.entityId);
}

async function rankedEntityIds(
  projectId: string,
  query: string,
  mode: Mode,
  limit: number,
): Promise<string[]> {
  // Pull a wider slice so RRF has overlap to reward; slice to `limit` at the end.
  const pool = Math.max(limit * 2, limit);
  const lexical = bm25EntityIds(projectId, query, pool);
  if (mode === 'bm25') return lexical.slice(0, limit);

  // hybrid: RRF-fuse OR-BM25 with semantic (cosine over memory embeddings).
  // semanticSearch returns [] when no embedder is configured → falls back to lexical.
  const semantic = (await semanticSearch(projectId, query, pool)).map(
    (hit) => hit.entityId,
  );
  if (semantic.length === 0) return lexical.slice(0, limit);
  const fused = reciprocalRankFusion([lexical, semantic]);
  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([entityId]) => entityId);
}

export async function retrieve(
  seeded: SeededQuestion,
  query: string,
  mode: Mode,
  limit: number,
): Promise<string[]> {
  const entityIds = await rankedEntityIds(seeded.projectId, query, mode, limit);
  const seen = new Set<string>();
  const sessionIds: string[] = [];
  for (const entityId of entityIds) {
    const sessionId = seeded.sessionIdByMemoryId.get(entityId);
    if (sessionId && !seen.has(sessionId)) {
      seen.add(sessionId);
      sessionIds.push(sessionId);
    }
  }
  return sessionIds;
}
