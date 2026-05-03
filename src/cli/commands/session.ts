import { reapStaleSessions } from '../../services/session-service.js';
import type { CliContext } from '../context.js';
import { renderScaffoldUsage } from '../usage.js';

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
  console.log(renderScaffoldUsage());
}
