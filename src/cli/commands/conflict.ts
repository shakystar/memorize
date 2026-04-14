import { loadStartContext } from '../../services/context-service.js';
import { getBoundProjectId } from '../../services/project-service.js';
import type { CliContext } from '../context.js';

export async function runConflictCommand(
  _args: string[],
  ctx: CliContext,
): Promise<void> {
  const projectId = await getBoundProjectId(ctx.cwd);
  if (!projectId) throw new Error('No project bound to current directory.');
  const payload = await loadStartContext({ projectId });
  console.log(JSON.stringify(payload.openConflicts, null, 2));
}
