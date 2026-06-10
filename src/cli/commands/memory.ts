import process from 'node:process';

import { ACTOR_SYSTEM } from '../../domain/common.js';
import { autoPush } from '../../services/auto-sync-service.js';
import { importMemories } from '../../services/memory-import-service.js';
import { requireBoundProjectId } from '../../services/project-service.js';
import { getSession } from '../../services/projection-store.js';
import type { CliContext } from '../context.js';

const USAGE =
  'Usage: echo \'[{"kind":"decision","text":"...","salience":7}]\' | ' +
  'memorize memory import --source <label> [--session <id>]';

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
  if (args[0] !== 'import') {
    throw new Error(USAGE);
  }

  const sourceFlag = args.indexOf('--source');
  const source = sourceFlag !== -1 ? args[sourceFlag + 1] : undefined;
  if (!source) {
    throw new Error(USAGE);
  }
  const sessionFlag = args.indexOf('--session');
  const sessionId = sessionFlag !== -1 ? args[sessionFlag + 1] : undefined;
  if (sessionFlag !== -1 && !sessionId) {
    throw new Error(USAGE);
  }

  const itemsJson = await readStdin();
  if (!itemsJson?.trim()) {
    throw new Error(`memory import: expected a JSON array on stdin. ${USAGE}`);
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
