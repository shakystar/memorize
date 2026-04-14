import { rebuildProjection } from '../../services/repair-service.js';
import type { CliContext } from '../context.js';
import { renderScaffoldUsage } from '../usage.js';

export async function runProjectionCommand(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  if (args[0] === 'rebuild') {
    console.log(await rebuildProjection(ctx.cwd));
    return;
  }
  console.log(renderScaffoldUsage());
}
