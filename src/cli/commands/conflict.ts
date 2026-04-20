import { loadStartContext } from '../../services/context-service.js';
import { requireBoundProjectId } from '../../services/project-service.js';
import type { CliContext } from '../context.js';

export async function runConflictCommand(
  _args: string[],
  ctx: CliContext,
): Promise<void> {
  const projectId = await requireBoundProjectId(ctx.cwd);
  const payload = await loadStartContext({ projectId });
  console.log(JSON.stringify(payload.openConflicts, null, 2));
}
