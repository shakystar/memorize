import { ACTOR_USER } from '../../domain/common.js';
import { resolveConflict } from '../../services/conflict-service.js';
import { loadStartContext } from '../../services/context-service.js';
import { requireBoundProjectId } from '../../services/project-service.js';
import type { CliContext } from '../context.js';
import { parseFlags } from '../parse-flags.js';

export async function runConflictCommand(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  const projectId = await requireBoundProjectId(ctx.cwd);

  if (args[0] === 'resolve') {
    const conflictId = args[1];
    if (!conflictId || conflictId.startsWith('-')) {
      throw new Error('Usage: memorize conflict resolve <id> [--summary <text>]');
    }
    const flags = parseFlags(args.slice(2), { single: ['summary'] });
    const summary = flags.single.summary?.trim();
    await resolveConflict(projectId, conflictId, {
      actor: ACTOR_USER,
      ...(summary ? { summary } : {}),
    });
    console.log(`Conflict ${conflictId} resolved`);
    return;
  }

  // Bare `conflict` and explicit `conflict list` both print the open-conflict
  // list. Any OTHER first arg is a typo/unknown verb — reject it instead of
  // silently falling through to the list (e.g. `conflict resovle`).
  if (args.length === 0 || args[0] === 'list') {
    const payload = await loadStartContext({ projectId });
    console.log(JSON.stringify(payload.openConflicts, null, 2));
    return;
  }

  throw new Error(
    `Unknown conflict subcommand: ${args[0]}. ` +
      'Usage: memorize conflict list | conflict resolve <id> [--summary <text>]',
  );
}
