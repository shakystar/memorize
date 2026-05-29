import {
  DEFAULT_SEARCH_LIMIT,
  searchFromCwd,
} from '../../services/search-service.js';
import type { CliContext } from '../context.js';
import { parseFlags } from '../parse-flags.js';

export async function runSearchCommand(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  const flags = parseFlags(args, { single: ['limit'], boolean: ['json'] });
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

  const hits = await searchFromCwd(ctx.cwd, query, limit);

  if (flags.boolean.json) {
    console.log(JSON.stringify(hits, null, 2));
    return;
  }

  if (hits.length === 0) {
    console.log('No matches found.');
    return;
  }
  for (const hit of hits) {
    console.log(`${hit.kind}\t${hit.entityId}\t${hit.snippet}`);
  }
}
