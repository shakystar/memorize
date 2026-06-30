import process from 'node:process';

import { ACTOR_SYSTEM, PERSONAL_STORE_ID } from '../../domain/common.js';
import {
  importPersonalMemories,
  listPersonalMemories,
} from '../../services/personal-store-service.js';
import { getMemory, type ValidMemoryRow } from '../../services/projection-store.js';
import type { CliContext } from '../context.js';
import { parseFlags } from '../parse-flags.js';

const IMPORT_USAGE =
  'Usage: echo \'[{"kind":"decision","text":"...","salience":7}]\' | ' +
  'memorize personal import --source <label>';

const LIST_USAGE = 'Usage: memorize personal list [--json] [--limit <N>]';

const SHOW_USAGE = 'Usage: memorize personal show <memoryId> [--json]';

const USAGE = `${IMPORT_USAGE}\n${LIST_USAGE}\n${SHOW_USAGE}`;

async function readStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) {
    return undefined;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * `memorize personal …` — the global/personal memory pipeline (Path A). A
 * host-level, account-scoped store for cross-project personal memory that is
 * deliberately separate from project memory. The PRIMARY capture path is
 * automatic — the consolidation extractor classifies personal items and routes
 * them here (see personal-store-service). This `import` subcommand is the
 * SECONDARY, explicit path for pushing in pre-existing external notes. The
 * store never leaves the host over sync, and is bound to no cwd, so — unlike
 * `memory …` — these commands need no bound project.
 */
export async function runPersonalCommand(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  const subcommand = args[0];
  if (subcommand === 'import') {
    await runPersonalImport(args.slice(1), ctx);
    return;
  }
  if (subcommand === 'list') {
    runPersonalList(args.slice(1));
    return;
  }
  if (subcommand === 'show') {
    runPersonalShow(args.slice(1));
    return;
  }
  throw new Error(USAGE);
}

async function runPersonalImport(
  args: string[],
  _ctx: CliContext,
): Promise<void> {
  const flags = parseFlags(args, { single: ['source'] });
  const source = flags.single.source;
  if (!source) {
    throw new Error(IMPORT_USAGE);
  }

  const itemsJson = await readStdin();
  if (!itemsJson?.trim()) {
    throw new Error(
      `personal import: expected a JSON array on stdin. ${IMPORT_USAGE}`,
    );
  }

  // No autoPush: the personal store is never propagated over sync.
  const result = await importPersonalMemories({
    actor: ACTOR_SYSTEM,
    source,
    itemsJson,
  });
  console.log(JSON.stringify(result));
}

function runPersonalList(args: string[]): void {
  const flags = parseFlags(args, { single: ['limit'], boolean: ['json'] });

  let limit: number | undefined;
  if (flags.single.limit !== undefined) {
    limit = Number(flags.single.limit);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('--limit must be a positive integer.');
    }
  }

  const rows = listPersonalMemories().sort((a, b) => {
    if (b.memory.salience !== a.memory.salience) {
      return b.memory.salience - a.memory.salience;
    }
    return a.memory.createdAt < b.memory.createdAt ? 1 : -1;
  });
  const capped = limit !== undefined ? rows.slice(0, limit) : rows;

  if (flags.boolean.json) {
    console.log(JSON.stringify(capped, null, 2));
    return;
  }

  for (const row of capped) {
    const { memory } = row;
    const snippet = memory.text.replace(/\s+/g, ' ').trim().slice(0, 80);
    console.log(`${memory.id}\t${memory.kind}\t${memory.salience}\t${snippet}`);
  }
}

function runPersonalShow(args: string[]): void {
  const flags = parseFlags(args, { boolean: ['json'] });
  const memoryId = flags.positional[0];
  if (!memoryId) {
    throw new Error(SHOW_USAGE);
  }

  const row = getMemory(PERSONAL_STORE_ID, memoryId);
  if (!row) {
    throw new Error(`personal show: no memory found with id ${memoryId}.`);
  }

  if (flags.boolean.json) {
    console.log(JSON.stringify(row, null, 2));
    return;
  }

  console.log(renderMemory(row));
}

function renderMemory(row: ValidMemoryRow): string {
  const { memory } = row;
  const lines: string[] = [
    `id:        ${memory.id}`,
    `kind:      ${memory.kind}`,
    `salience:  ${memory.salience}`,
  ];
  if (memory.tags?.length) lines.push(`tags:      ${memory.tags.join(', ')}`);
  if (memory.importSource) {
    lines.push(`source:    import (${memory.importSource})`);
  }
  lines.push(`createdAt: ${memory.createdAt}`);
  if (memory.obsoleteWhen) lines.push(`obsolete:  ${memory.obsoleteWhen}`);
  lines.push('', memory.text);
  return lines.join('\n');
}
