import {
  DEFAULT_SEARCH_LIMIT,
  hybridSearchFromCwd,
  searchFromCwd,
  type SearchHit,
} from '../../services/search-service.js';
import type { CliContext } from '../context.js';
import { parseFlags } from '../parse-flags.js';

/**
 * One human-output line per hit. A foreign (union-lane) hit is prefixed with
 * its writer id in brackets; a self hit keeps the legacy format. The snippet's
 * internal whitespace is collapsed to single spaces so a hit whose FTS snippet
 * spans the newline-joined title/description/goal text stays on ONE physical
 * row — otherwise the continuation lines orphan from their kind/id (and, for a
 * foreign hit, from the provenance tag). Matches `memory list`'s rendering.
 */
export function formatHitLine(hit: SearchHit): string {
  const snippet = hit.snippet.replace(/\s+/g, ' ').trim();
  const base = `${hit.kind}\t${hit.entityId}\t${snippet}`;
  return hit.sourceProjectId ? `[${hit.sourceProjectId}] ${base}` : base;
}

export async function runSearchCommand(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  const flags = parseFlags(args, {
    single: ['limit'],
    boolean: ['json', 'lexical', 'union'],
  });
  const query = flags.positional.join(' ').trim();
  if (!query) {
    throw new Error('Search query is required.');
  }

  let limit = DEFAULT_SEARCH_LIMIT;
  if (flags.single.limit !== undefined) {
    limit = Number(flags.single.limit);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('--limit must be a positive integer.');
    }
  }

  const lane = flags.boolean.union ? 'union' : 'self';

  // Hybrid (lexical + semantic) by default; --lexical forces pure FTS. With no
  // embeddings endpoint configured, hybrid already degrades to lexical.
  const hits = flags.boolean.lexical
    ? await searchFromCwd(ctx.cwd, query, limit, lane)
    : await hybridSearchFromCwd(ctx.cwd, query, limit, lane);

  if (flags.boolean.json) {
    console.log(JSON.stringify(hits, null, 2));
    return;
  }

  if (hits.length === 0) {
    console.log('No matches found.');
    return;
  }
  for (const hit of hits) {
    console.log(formatHitLine(hit));
  }
}
