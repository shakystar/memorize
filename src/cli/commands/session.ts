import { requireBoundProjectId } from '../../services/project-service.js';
import { resolveSessionContext } from '../../services/session-context.js';
import {
  buildSessionOverview,
  reapStaleSessions,
} from '../../services/session-service.js';
import type { CliContext } from '../context.js';
import { renderScaffoldUsage } from '../usage.js';

const ACTIVITY_DEFAULT_LIMIT = 10;

/**
 * `memorize session list|activity|reap` — #83: the on-demand answer to
 * "what are my other sessions doing?". `list` shows claiming sessions;
 * `activity` adds each session's recent captured observations. Sessions
 * with no captured activity are shown honestly instead of omitted (a
 * plan-mode session that only reads captures little by design).
 */
export async function runSessionCommand(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  const sub = args[0];
  if (sub === 'reap') {
    const force = args.includes('--force');
    const result = await reapStaleSessions(ctx.cwd, { force });
    if (result.reapedSessionIds.length === 0) {
      console.log('memorize: no stale sessions to reap');
      return;
    }
    console.log(
      `memorize: reaped ${result.reapedSessionIds.length} session(s):`,
    );
    for (const id of result.reapedSessionIds) {
      console.log(`  ${id}`);
    }
    return;
  }

  if (sub === 'list' || sub === 'activity') {
    const limitFlag = args.indexOf('--limit');
    const limit =
      limitFlag !== -1
        ? Number.parseInt(args[limitFlag + 1] ?? '', 10)
        : ACTIVITY_DEFAULT_LIMIT;
    const perSession =
      sub === 'activity'
        ? Number.isFinite(limit) && limit > 0
          ? limit
          : ACTIVITY_DEFAULT_LIMIT
        : 0;

    const projectId = await requireBoundProjectId(ctx.cwd);
    // Best-effort self marker — an unresolvable pointer (codex without env
    // var, plain terminal) just means nothing is flagged as `self`.
    let selfSessionId: string | undefined;
    try {
      selfSessionId = (
        await resolveSessionContext(ctx.cwd, { debugLabel: 'session-overview' })
      ).sessionId;
    } catch {
      // overview still works without a self marker
    }

    const overview = await buildSessionOverview(projectId, {
      ...(selfSessionId ? { selfSessionId } : {}),
      observationsPerSession: perSession,
    });

    if (args.includes('--json')) {
      console.log(JSON.stringify(overview, null, 2));
      return;
    }
    if (overview.length === 0) {
      console.log(
        'memorize: no active sessions for this project (sessions appear once an agent with memorize hooks starts in it)',
      );
      return;
    }
    console.log(`${overview.length} active session(s):`);
    for (const entry of overview) {
      const selfMark = entry.self ? ', self' : '';
      const task = entry.taskId ? ` — task ${entry.taskId}` : '';
      console.log(
        `* ${entry.id} (${entry.actor}, ${entry.status}${selfMark}) — last seen ${entry.lastSeenAt}${task}`,
      );
      if (sub === 'activity') {
        if (entry.observations.length === 0) {
          console.log('    (no captured activity yet)');
        }
        for (const observation of entry.observations) {
          const tool = observation.toolName ? `/${observation.toolName}` : '';
          console.log(
            `    [${observation.signal}${tool}] ${observation.summary ?? observation.createdAt}`,
          );
        }
      }
    }
    return;
  }

  console.log(renderScaffoldUsage());
}
