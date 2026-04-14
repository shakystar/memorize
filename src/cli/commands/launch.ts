import { launchAgent } from '../../services/launch-service.js';
import type { CliContext } from '../context.js';

export async function runLaunchCommand(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  const agent = args[0];
  if (agent !== 'claude' && agent !== 'codex') {
    throw new Error('Launch target must be `claude` or `codex`.');
  }
  const passthroughIndex = args.indexOf('--');
  const passthroughArgs =
    passthroughIndex === -1 ? [] : args.slice(passthroughIndex + 1);
  await launchAgent({
    agent,
    cwd: ctx.cwd,
    passthroughArgs,
  });
}
