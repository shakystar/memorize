import { runWorkflow } from '../../workflows/macros/run.js';
import { parseIntent } from '../../workflows/router.js';
import type { CliContext } from '../context.js';

export async function runDoCommand(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  const sentence = args.join(' ').trim();
  if (!sentence) throw new Error('A sentence command is required.');
  console.log(await runWorkflow(parseIntent(sentence), ctx.cwd));
}
