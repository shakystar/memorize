import process from 'node:process';

import { ACTOR_SYSTEM } from '../../domain/common.js';
import { autoPush } from '../../services/auto-sync-service.js';
import { importMemories } from '../../services/memory-import-service.js';
import { requireBoundProjectId } from '../../services/project-service.js';
import {
  getMemory,
  getSession,
  type ValidMemoryRow,
} from '../../services/projection-store.js';
import type { CliContext } from '../context.js';
import { parseFlags } from '../parse-flags.js';

const IMPORT_USAGE =
  'Usage: echo \'[{"kind":"decision","text":"...","salience":7}]\' | ' +
  'memorize memory import --source <label> [--session <id>]';

const SHOW_USAGE = 'Usage: memorize memory show <memoryId> [--json]';

const USAGE = `${IMPORT_USAGE}\n${SHOW_USAGE}`;

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
  throw new Error(USAGE);
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

  lines.push('', memory.text);
  return lines.join('\n');
}
