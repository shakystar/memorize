import { requireBoundProjectId } from '../../services/project-service.js';
import {
  acquireWatcherLock,
  releaseWatcherLock,
  runWatcherLoop,
} from '../../services/watcher-service.js';
import type { CliContext } from '../context.js';

const USAGE = [
  'Usage:',
  '  memorize watcher run    Run the session-bound sync watcher loop (internal;',
  '                          SessionStart spawns this detached — SoT-042/043).',
].join('\n');

/**
 * `memorize watcher run` — the long-lived watcher-sync loop. Internal
 * surface: SessionStart spawns it detached; running it by hand is only for
 * debugging a stuck sync. It is in SESSION_MANAGING_COMMANDS (no heartbeat):
 * a background pump must never masquerade as agent liveness — it would keep
 * ITSELF alive forever through the very signal it polls.
 */
export async function runWatcherCommand(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  const subcommand = args[0] ?? 'run';
  if (subcommand !== 'run') {
    throw new Error(`Unknown watcher subcommand "${subcommand}".\n${USAGE}`);
  }
  const projectId = await requireBoundProjectId(ctx.cwd);
  // The atomic acquire IS the single-instance guarantee (SoT-042); the
  // spawner's pre-check is only a fast path. Losing here is the normal
  // outcome of a two-SessionStart race — report and exit clean.
  if (!(await acquireWatcherLock(projectId))) {
    console.log(JSON.stringify({ ran: false, reason: 'already-running' }));
    return;
  }
  try {
    const result = await runWatcherLoop({ cwd: ctx.cwd, projectId });
    console.log(JSON.stringify({ ran: true, ...result }));
  } finally {
    await releaseWatcherLock(projectId);
  }
}
