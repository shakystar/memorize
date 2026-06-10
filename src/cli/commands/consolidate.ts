import { ACTOR_SYSTEM } from '../../domain/common.js';
import { autoPush } from '../../services/auto-sync-service.js';
import { consolidate } from '../../services/consolidate-service.js';
import { requireBoundProjectId } from '../../services/project-service.js';
import { getSession } from '../../services/projection-store.js';
import type { CliContext } from '../context.js';

/**
 * `memorize consolidate [--session <id>]` — run one memory-consolidation
 * boundary for the project bound to cwd. This is what the boundary hooks
 * (SessionStart catch-up / PostCompact / SessionEnd) spawn as a detached
 * background child (#46) so consolidation never blocks the agent; it is
 * equally valid to run by hand.
 */
export async function runConsolidateCommand(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  const sessionFlag = args.indexOf('--session');
  const sessionId =
    sessionFlag !== -1 ? args[sessionFlag + 1] : undefined;
  if (sessionFlag !== -1 && !sessionId) {
    throw new Error('Usage: memorize consolidate [--session <id>]');
  }

  const projectId = await requireBoundProjectId(ctx.cwd);
  // Attribute the consolidated events to the session's agent when known;
  // 'system' otherwise (the memory payload itself carries the sessionId).
  const actor =
    (sessionId ? getSession(projectId, sessionId)?.actor : undefined) ??
    ACTOR_SYSTEM;

  const result = await consolidate({
    projectId,
    actor,
    ...(sessionId ? { sessionId } : {}),
  });
  // Background propagation parity with the old inline boundary path: push
  // the new events to configured siblings. No-op without a transport,
  // never throws.
  await autoPush(projectId);
  console.log(JSON.stringify(result));
}
