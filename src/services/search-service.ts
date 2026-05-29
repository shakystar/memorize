import { getDb } from '../storage/db.js';
import type { SearchKind } from './projection-store.js';
import { requireBoundProjectId } from './project-service.js';

export interface SearchHit {
  entityId: string;
  kind: SearchKind;
  /** bm25 relevance score (ascending = more relevant; lower is better). */
  score: number;
  /** FTS5 snippet of the matched `text` column with `[`…`]` highlights. */
  snippet: string;
}

export const DEFAULT_SEARCH_LIMIT = 20;

/**
 * Turn arbitrary user input into a safe FTS5 MATCH expression. FTS5 treats
 * unquoted text as query syntax (operators like AND/OR/NEAR, prefixes,
 * column filters, and punctuation can raise "fts5: syntax error"). We split on
 * whitespace and wrap each token as an FTS5 *string* (double-quoted, with
 * embedded `"` doubled), then join with a space — an implicit AND of phrase
 * tokens. This makes any punctuation literal and injection-proof while still
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
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' ');
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
): SearchHit[] {
  const match = toFtsMatch(query);
  if (!match) return [];

  const rows = getDb(projectId)
    .prepare(
      `SELECT entity_id   AS entityId,
              kind        AS kind,
              snippet(search_fts, 2, '[', ']', '…', 10) AS snippet,
              bm25(search_fts) AS score
         FROM search_fts
        WHERE search_fts MATCH ?
        ORDER BY bm25(search_fts)
        LIMIT ?`,
    )
    .all(match, limit) as Array<{
    entityId: string;
    kind: SearchKind;
    snippet: string;
    score: number;
  }>;

  return rows;
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
