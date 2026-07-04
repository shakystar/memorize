import { getDb } from '../storage/db.js';
import {
  cosineSimilarity,
  getEmbedder,
  reciprocalRankFusion,
  type Embedder,
} from './embeddings-service.js';
import { listEmbeddings } from './embeddings-store.js';
import { listSegmentTexts } from './segment-store.js';
import {
  laneWhere,
  listValidMemories,
  type ProjectionLane,
  type SearchKind,
} from './projection-store.js';
import { requireBoundProjectId } from './project-service.js';

export interface SearchHit {
  entityId: string;
  kind: SearchKind;
  /** bm25 relevance score (ascending = more relevant; lower is better). */
  score: number;
  /** FTS5 snippet of the matched `text` column with `[`…`]` highlights. */
  snippet: string;
  /**
   * Origin store id for a foreign (union-lane) hit; ABSENT for a self hit.
   * Absence — not null — encodes "self" (SoT-040: group by writer, never fold
   * a foreign row into local truth).
   */
  sourceProjectId?: string;
}

export const DEFAULT_SEARCH_LIMIT = 20;

/**
 * Turn arbitrary user input into a safe FTS5 MATCH expression. FTS5 treats
 * unquoted text as query syntax (operators like AND/OR/NEAR, prefixes,
 * column filters, and punctuation can raise "fts5: syntax error"). We split on
 * whitespace and wrap each token as an FTS5 *string* (double-quoted, with
 * embedded `"` doubled), then join with ` OR ` so a natural-language query
 * matches documents containing ANY of its tokens (BM25 ranks the results by
 * relevance). This makes punctuation literal and injection-proof while still
 * being passed as a bound parameter. Returns undefined when the query has no
 * searchable tokens (e.g. empty or punctuation-only).
 */
export function toFtsMatch(query: string): string | undefined {
  const tokens = query
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    // Drop tokens that contain no alphanumeric/word characters — a bare `"`
    // or `*` quoted alone is still a valid FTS string but matches nothing
    // useful, and an empty quoted string `""` is a syntax error.
    .filter((token) => /[\p{L}\p{N}]/u.test(token));
  if (tokens.length === 0) return undefined;
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ');
}

/**
 * Full-text search over the bound project's `search_fts` index. Returns hits
 * ordered by bm25 relevance (most relevant first). An empty/punctuation-only
 * query yields no hits rather than erroring.
 */
export function searchProject(
  projectId: string,
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
  lane: ProjectionLane = 'self',
): SearchHit[] {
  const match = toFtsMatch(query);
  if (!match) return [];

  const rows = getDb(projectId)
    .prepare(
      `SELECT entity_id         AS entityId,
              kind              AS kind,
              snippet(search_fts, 2, '[', ']', '…', 10) AS snippet,
              bm25(search_fts)  AS score,
              source_project_id AS sourceProjectId
         FROM search_fts
        WHERE search_fts MATCH ? AND ${laneWhere(lane)}
        ORDER BY bm25(search_fts)
        LIMIT ?`,
    )
    .all(match, limit) as Array<{
    entityId: string;
    kind: SearchKind;
    snippet: string;
    score: number;
    sourceProjectId: string | null;
  }>;

  return rows.map(({ sourceProjectId, ...hit }) =>
    sourceProjectId === null ? hit : { ...hit, sourceProjectId },
  );
}

/** Resolve the project bound to `cwd`, then search it. */
export async function searchFromCwd(
  cwd: string,
  query: string,
  limit?: number,
): Promise<SearchHit[]> {
  const projectId = await requireBoundProjectId(cwd);
  return searchProject(projectId, query, limit ?? DEFAULT_SEARCH_LIMIT);
}

// --- P3-c semantic + hybrid search ------------------------------------------

function snippetFromText(text: string, max = 120): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

/**
 * Cosine similarity of `query` against every valid-memory embedding, as an
 * id→score map (score in [-1, 1]). Empty when embeddings are unconfigured, the
 * corpus is unembedded, or the query embed fails (best-effort — the caller then
 * degrades to lexical-only). This is the shared core for both semanticSearch and
 * the injection-time relevance boost.
 */
export async function semanticScoresForKind(
  projectId: string,
  query: string,
  kind: string,
  embedder: Embedder | undefined = getEmbedder(),
  queryVec?: number[],
): Promise<Map<string, number>> {
  if (!embedder || !query.trim()) return new Map();
  const corpus = listEmbeddings(projectId, kind);
  if (corpus.length === 0) return new Map();
  let vec = queryVec;
  if (!vec) {
    try {
      [vec] = await embedder.embed([query]);
    } catch {
      return new Map();
    }
  }
  if (!vec || vec.length === 0) return new Map();
  const scores = new Map<string, number>();
  for (const row of corpus) {
    scores.set(row.entityId, cosineSimilarity(vec, row.vector));
  }
  return scores;
}

export async function semanticMemoryScores(
  projectId: string,
  query: string,
  embedder: Embedder | undefined = getEmbedder(),
): Promise<Map<string, number>> {
  return semanticScoresForKind(projectId, query, 'memory', embedder);
}

/** Memory hits ranked by embedding similarity (best-first). Empty when off. */
export async function semanticSearch(
  projectId: string,
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
  embedder: Embedder | undefined = getEmbedder(),
): Promise<SearchHit[]> {
  const scores = await semanticMemoryScores(projectId, query, embedder);
  if (scores.size === 0) return [];
  const textById = new Map(
    listValidMemories(projectId).map((row) => [row.memory.id, row.memory.text]),
  );
  // Score only VALID memories. Embeddings survive projection rebuilds and are
  // not pruned when a memory is invalidated (byte reclamation is a GC concern),
  // so the corpus still holds vectors for superseded / deduped / retracted
  // memories — they must not surface here. Filtering to `textById` (the valid
  // set) drops them uniformly BEFORE the limit slice, so retrieval matches the
  // FTS/injection paths, which already exclude invalidated memories (SoT-050).
  return [...scores.entries()]
    .filter(([entityId]) => textById.has(entityId))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([entityId, score]) => ({
      entityId,
      kind: 'memory' as SearchKind,
      score,
      snippet: snippetFromText(textById.get(entityId)!),
    }));
}

/**
 * Fuse FTS5 lexical and semantic (embedding) rankings via Reciprocal Rank
 * Fusion — scale-free, no score normalization. Returns SearchHit[] best-first.
 *
 * NOTE: unlike searchProject (`score` = bm25, lower is better), the hybrid
 * `score` is the RRF score (higher is better). When embeddings are off the
 * semantic list is empty and this returns exactly searchProject's FTS order.
 */
export async function hybridSearch(
  projectId: string,
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
  embedder: Embedder | undefined = getEmbedder(),
): Promise<SearchHit[]> {
  // Pull a wider slice from each ranker so fusion has overlap to reward.
  const poolSize = Math.max(limit * 2, DEFAULT_SEARCH_LIMIT);
  const ftsHits = searchProject(projectId, query, poolSize);
  const semantic = await semanticSearch(projectId, query, poolSize, embedder);
  if (semantic.length === 0) return ftsHits.slice(0, limit);

  const fused = reciprocalRankFusion([
    ftsHits.map((hit) => hit.entityId),
    semantic.map((hit) => hit.entityId),
  ]);
  // FTS snippet preferred (sentence-aware highlight); fall back to the
  // semantic hit's truncated memory text for semantic-only matches.
  const byId = new Map<string, SearchHit>();
  for (const hit of semantic) byId.set(hit.entityId, hit);
  for (const hit of ftsHits) byId.set(hit.entityId, hit);
  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([entityId, score]) => ({ ...byId.get(entityId)!, score }));
}

/** Resolve the project bound to `cwd`, then hybrid-search it (FTS when off). */
export async function hybridSearchFromCwd(
  cwd: string,
  query: string,
  limit?: number,
): Promise<SearchHit[]> {
  const projectId = await requireBoundProjectId(cwd);
  return hybridSearch(projectId, query, limit ?? DEFAULT_SEARCH_LIMIT);
}

// --- v10 raw-segment retrieval ----------------------------------------------

/** FTS over a single entity `kind` (e.g. 'segment'), bm25-ordered. */
export function searchByKind(
  projectId: string,
  query: string,
  kind: SearchKind,
  limit: number = DEFAULT_SEARCH_LIMIT,
  lane: ProjectionLane = 'self',
): SearchHit[] {
  const match = toFtsMatch(query);
  if (!match) return [];
  const rows = getDb(projectId)
    .prepare(
      `SELECT entity_id         AS entityId,
              kind              AS kind,
              snippet(search_fts, 2, '[', ']', '…', 10) AS snippet,
              bm25(search_fts)  AS score,
              source_project_id AS sourceProjectId
         FROM search_fts
        WHERE search_fts MATCH ? AND kind = ? AND ${laneWhere(lane)}
        ORDER BY bm25(search_fts)
        LIMIT ?`,
    )
    .all(match, kind, limit) as Array<{
    entityId: string;
    kind: SearchKind;
    snippet: string;
    score: number;
    sourceProjectId: string | null;
  }>;

  return rows.map(({ sourceProjectId, ...hit }) =>
    sourceProjectId === null ? hit : { ...hit, sourceProjectId },
  );
}

/**
 * Hybrid (FTS + semantic RRF) search over raw transcript segments. Snippets are
 * hydrated from the `segments` table (segment text is not in the projection). An
 * optional precomputed `queryVec` lets a caller embed the query once and reuse it
 * across the memory and segment corpora. Returns [] when there are no segments.
 */
export async function hybridSearchSegments(
  projectId: string,
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
  embedder: Embedder | undefined = getEmbedder(),
  queryVec?: number[],
): Promise<SearchHit[]> {
  const poolSize = Math.max(limit * 2, DEFAULT_SEARCH_LIMIT);
  const ftsHits = searchByKind(projectId, query, 'segment', poolSize);
  const scores = await semanticScoresForKind(projectId, query, 'segment', embedder, queryVec);
  const texts = listSegmentTexts(projectId);
  const hydrate = (id: string, snippet: string): string =>
    snippet || snippetFromText(texts.get(id) ?? '');

  if (scores.size === 0) {
    return ftsHits
      .slice(0, limit)
      .map((hit) => ({ ...hit, snippet: hydrate(hit.entityId, hit.snippet) }));
  }
  const semanticIds = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, poolSize)
    .map(([id]) => id);
  const fused = reciprocalRankFusion([ftsHits.map((h) => h.entityId), semanticIds]);
  const byId = new Map<string, SearchHit>();
  for (const id of semanticIds) {
    byId.set(id, { entityId: id, kind: 'segment', score: scores.get(id) ?? 0, snippet: '' });
  }
  for (const hit of ftsHits) byId.set(hit.entityId, hit);
  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, score]) => {
      const hit = byId.get(id)!;
      return { ...hit, score, snippet: hydrate(id, hit.snippet) };
    });
}
