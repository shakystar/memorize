import { ACTOR_SYSTEM } from '../../domain/common.js';
import { autoPush } from '../../services/auto-sync-service.js';
import {
  CONSOLIDATE_BOUNDARIES,
  type ConsolidateBoundary,
  buildLifecycleEvidenceReport,
  consolidate,
} from '../../services/consolidate-service.js';
import { buildMemoryBehaviorReport } from '../../services/memory-telemetry-service.js';
import { requireBoundProjectId } from '../../services/project-service.js';
import { getSession } from '../../services/projection-store.js';
import type { CliContext } from '../context.js';

/**
 * `memorize consolidate [--session <id>] [--boundary <label>]` — run one
 * memory-consolidation boundary for the project bound to cwd. This is what
 * the boundary hooks
 * (SessionStart catch-up / PostCompact / SessionEnd) spawn as a detached
 * background child (#46) so consolidation never blocks the agent; it is
 * equally valid to run by hand.
 *
 * `memorize consolidate --report` — print the lifecycle evidence as JSON
 * instead of running a boundary: the extraction-side distribution (#57 —
 * obsolete_when presence x kind, kind-misfit rate + reasons, tag x kind)
 * plus the behavioral side (#62 — kind x injections/superseded/contradicted/
 * deduped/age-at-invalidation) under `behavior`.
 */
export async function runConsolidateCommand(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  if (args.includes('--report')) {
    const projectId = await requireBoundProjectId(ctx.cwd);
    console.log(
      JSON.stringify(
        {
          ...buildLifecycleEvidenceReport(projectId),
          behavior: await buildMemoryBehaviorReport(projectId),
        },
        null,
        2,
      ),
    );
    return;
  }

  const sessionFlag = args.indexOf('--session');
  const sessionId =
    sessionFlag !== -1 ? args[sessionFlag + 1] : undefined;
  if (sessionFlag !== -1 && !sessionId) {
    throw new Error('Usage: memorize consolidate [--session <id>]');
  }

  // #51: boundary label for the recorded attempt. Whitelisted; a missing or
  // junk value reads as 'manual' — a bad label must never fail the boundary.
  const boundaryFlag = args.indexOf('--boundary');
  const rawBoundary = boundaryFlag !== -1 ? args[boundaryFlag + 1] : undefined;
  const boundary: ConsolidateBoundary = (
    CONSOLIDATE_BOUNDARIES as readonly string[]
  ).includes(rawBoundary ?? '')
    ? (rawBoundary as ConsolidateBoundary)
    : 'manual';

  const projectId = await requireBoundProjectId(ctx.cwd);
  // Attribute the consolidated events to the session's agent when known;
  // 'system' otherwise (the memory payload itself carries the sessionId).
  const actor =
    (sessionId ? getSession(projectId, sessionId)?.actor : undefined) ??
    ACTOR_SYSTEM;

  const result = await consolidate({
    projectId,
    actor,
    boundary,
    ...(sessionId ? { sessionId } : {}),
  });
  // Background propagation parity with the old inline boundary path: push
  // the new events to configured siblings. No-op without a transport,
  // never throws.
  await autoPush(projectId);
  console.log(JSON.stringify(result));
}
