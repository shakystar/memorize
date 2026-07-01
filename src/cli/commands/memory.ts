import process from 'node:process';

import { ACTOR_SYSTEM } from '../../domain/common.js';
import { autoPush } from '../../services/auto-sync-service.js';
import { gcUnpushedRetracted } from '../../services/gc-service.js';
import { importMemories } from '../../services/memory-import-service.js';
import {
  requireBoundProjectId,
  retractMemory,
  revertSession,
} from '../../services/project-service.js';
import {
  getMemory,
  getSession,
  listValidMemories,
  type ValidMemoryRow,
} from '../../services/projection-store.js';
import type { CliContext } from '../context.js';
import { parseFlags } from '../parse-flags.js';

const IMPORT_USAGE =
  'Usage: echo \'[{"kind":"decision","text":"...","salience":7}]\' | ' +
  'memorize memory import --source <label> [--session <id>]';

const SHOW_USAGE = 'Usage: memorize memory show <memoryId> [--json]';

const LIST_USAGE = 'Usage: memorize memory list [--json] [--limit <N>]';

const RETRACT_USAGE =
  'Usage: memorize memory retract <memoryId> [--reason <text>]';

const GC_USAGE = 'Usage: memorize memory gc [--dry-run] [--json]';

const REVERT_USAGE =
  'Usage: memorize memory revert --session <id> [--reason <text>] [--dry-run] [--json]';

const USAGE = `${IMPORT_USAGE}\n${SHOW_USAGE}\n${LIST_USAGE}\n${RETRACT_USAGE}\n${GC_USAGE}\n${REVERT_USAGE}`;

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
 * `memorize memory import --source <label>` — #69 ingestion primitive for
 * agent-driven absorption. The calling agent reads + distills pre-existing
 * context (its own harness memory, override files, user-named doc folders)
 * into extractor-shaped JSON items and pipes them here; see
 * guides/AI_SETUP.md for the offer→distill→import flow.
 */
export async function runMemoryCommand(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  const subcommand = args[0];
  if (subcommand === 'import') {
    await runMemoryImport(args, ctx);
    return;
  }
  if (subcommand === 'show') {
    await runMemoryShow(args.slice(1), ctx);
    return;
  }
  if (subcommand === 'list') {
    await runMemoryList(args.slice(1), ctx);
    return;
  }
  if (subcommand === 'retract') {
    await runMemoryRetract(args.slice(1), ctx);
    return;
  }
  if (subcommand === 'gc') {
    await runMemoryGc(args.slice(1), ctx);
    return;
  }
  if (subcommand === 'revert') {
    await runMemoryRevert(args.slice(1), ctx);
    return;
  }
  throw new Error(USAGE);
}

/**
 * `memorize memory revert --session <id> [--reason <text>] [--dry-run] [--json]`
 * — consolidated revert (M3-c, SoT-050). Batch-retracts every still-valid
 * memory a contaminated session produced, so the projection re-derives a clean
 * view without them. Append-only + reversible (it reuses the `memory.retracted`
 * tombstone); nothing is deleted. `--dry-run` lists what would be reverted.
 */
async function runMemoryRevert(args: string[], ctx: CliContext): Promise<void> {
  const flags = parseFlags(args, {
    single: ['session', 'reason'],
    boolean: ['dry-run', 'json'],
  });
  const sessionId = flags.single.session;
  if (!sessionId) {
    throw new Error(REVERT_USAGE);
  }

  const projectId = await requireBoundProjectId(ctx.cwd);
  const result = await revertSession({
    projectId,
    sessionId,
    ...(flags.single.reason ? { reason: flags.single.reason } : {}),
    dryRun: flags.boolean['dry-run'] ?? false,
  });
  // Propagate the tombstones like a consolidation boundary so peers converge.
  if (!result.dryRun && result.reverted.length > 0) {
    await autoPush(projectId);
  }

  if (flags.boolean.json) {
    console.log(JSON.stringify(result));
    return;
  }
  const verb = result.dryRun ? 'Would revert' : 'Reverted';
  console.log(
    `${verb} ${result.reverted.length} memory(ies) from session ${sessionId}.`,
  );
}

/**
 * `memorize memory gc [--dry-run] [--json]` — physically reclaim (M3-b) the
 * bytes of retracted memories whose whole derivation unit is LOCAL-ONLY
 * (un-pushed). Retract (M3-a) only tombstones/hides; this hard-deletes the
 * un-shared, already-retracted events — safe because nobody else has them
 * (SoT-050, `git reset --hard` on an un-pushed commit). Shared retracted
 * memories are left as tombstones (deferred: needs a retention policy).
 * `--dry-run` reports what WOULD be reclaimed without mutating anything.
 */
async function runMemoryGc(args: string[], ctx: CliContext): Promise<void> {
  const flags = parseFlags(args, { boolean: ['dry-run', 'json'] });
  const projectId = await requireBoundProjectId(ctx.cwd);
  const result = await gcUnpushedRetracted(projectId, {
    dryRun: flags.boolean['dry-run'] ?? false,
  });

  if (flags.boolean.json) {
    console.log(JSON.stringify(result));
    return;
  }
  const verb = result.dryRun ? 'Would reclaim' : 'Reclaimed';
  console.log(
    `${verb} ${result.reclaimedMemories.length} memory(ies) ` +
      `(${result.reclaimedEvents} events, ${result.reclaimedObservations} observations). ` +
      `Left ${result.skippedShared} shared/retained tombstone(s).`,
  );
}

/**
 * `memorize memory retract <id> [--reason <text>]` — tombstone a memory
 * (SoT-050). Appends a `memory.retracted` event and rebuilds the projection so
 * the memory stops surfacing in list/search/injection; nothing is deleted, so
 * it stays auditable and reversible. Propagates the tombstone like a
 * consolidation boundary (best-effort autoPush) so peers converge on the
 * removal instead of reviving it on the next union.
 */
async function runMemoryRetract(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  const flags = parseFlags(args, { single: ['reason'] });
  const memoryId = flags.positional[0];
  if (!memoryId) {
    throw new Error(RETRACT_USAGE);
  }
  const reason = flags.single.reason;

  const projectId = await requireBoundProjectId(ctx.cwd);
  const result = await retractMemory({
    projectId,
    memoryId,
    ...(reason ? { reason } : {}),
  });
  // Same propagation as a consolidation boundary: best-effort, never throws.
  await autoPush(projectId);
  console.log(JSON.stringify(result));
}

/**
 * `memorize memory list [--json] [--limit <N>]` — whole-store observation.
 * Lists the memories whose validity window is still open (superseded ones are
 * excluded — that is the correct default). Pure read of the derived
 * projection; appends nothing, mutates nothing.
 */
async function runMemoryList(args: string[], ctx: CliContext): Promise<void> {
  const flags = parseFlags(args, { single: ['limit'], boolean: ['json'] });

  let limit: number | undefined;
  if (flags.single.limit !== undefined) {
    limit = Number(flags.single.limit);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('--limit must be a positive integer.');
    }
  }

  const projectId = await requireBoundProjectId(ctx.cwd);
  const rows = listValidMemories(projectId).sort((a, b) => {
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

async function runMemoryImport(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  const sourceFlag = args.indexOf('--source');
  const source = sourceFlag !== -1 ? args[sourceFlag + 1] : undefined;
  if (!source) {
    throw new Error(IMPORT_USAGE);
  }
  const sessionFlag = args.indexOf('--session');
  const sessionId = sessionFlag !== -1 ? args[sessionFlag + 1] : undefined;
  if (sessionFlag !== -1 && !sessionId) {
    throw new Error(IMPORT_USAGE);
  }

  const itemsJson = await readStdin();
  if (!itemsJson?.trim()) {
    throw new Error(
      `memory import: expected a JSON array on stdin. ${IMPORT_USAGE}`,
    );
  }

  const projectId = await requireBoundProjectId(ctx.cwd);
  const actor =
    (sessionId ? getSession(projectId, sessionId)?.actor : undefined) ??
    ACTOR_SYSTEM;

  const result = await importMemories({
    projectId,
    actor,
    source,
    itemsJson,
    ...(sessionId ? { sessionId } : {}),
  });
  // Same propagation as a consolidation boundary: best-effort, never throws.
  await autoPush(projectId);
  console.log(JSON.stringify(result));
}

/**
 * `memorize memory show <memoryId> [--json]` — #111 read-the-full-memory
 * primitive. `search` only prints a truncated snippet; this is how an agent
 * (or human) reads a recalled memory's complete text plus its metadata
 * (kind, salience, provenance, validity window). Scope is the cwd-bound
 * project, mirroring how `search` resolves the project.
 */
async function runMemoryShow(args: string[], ctx: CliContext): Promise<void> {
  const flags = parseFlags(args, { boolean: ['json'] });
  const memoryId = flags.positional[0];
  if (!memoryId) {
    throw new Error(SHOW_USAGE);
  }

  const projectId = await requireBoundProjectId(ctx.cwd);
  const row = getMemory(projectId, memoryId);
  if (!row) {
    throw new Error(`memory show: no memory found with id ${memoryId}.`);
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

  // Provenance.
  if (memory.importSource) lines.push(`source:    import (${memory.importSource})`);
  else lines.push('source:    consolidation');
  if (memory.sessionId) lines.push(`session:   ${memory.sessionId}`);
  if (memory.sourceObservationIds.length) {
    lines.push(`from obs:  ${memory.sourceObservationIds.join(', ')}`);
  }

  // Validity window.
  lines.push(`createdAt: ${memory.createdAt}`);
  if (row.lastAccessedAt) lines.push(`accessed:  ${row.lastAccessedAt}`);
  if (memory.obsoleteWhen) lines.push(`obsolete:  ${memory.obsoleteWhen}`);
  if (memory.invalidAt) lines.push(`invalidAt: ${memory.invalidAt}`);
  if (memory.supersededBy) lines.push(`superseded by: ${memory.supersededBy}`);
  if (memory.dedupedBy) lines.push(`deduped by: ${memory.dedupedBy}`);
  if (memory.retractedAt) {
    lines.push(
      `retracted: ${memory.retractedAt}` +
        (memory.retractedBy ? ` (by ${memory.retractedBy})` : ''),
    );
  }

  lines.push('', memory.text);
  return lines.join('\n');
}
