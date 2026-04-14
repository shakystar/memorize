import { validateEvents } from '../../services/repair-service.js';
import type { CliContext } from '../context.js';
import { renderScaffoldUsage } from '../usage.js';

export async function runEventsCommand(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  if (args[0] === 'validate') {
    console.log(await validateEvents(ctx.cwd));
    return;
  }
  console.log(renderScaffoldUsage());
}
