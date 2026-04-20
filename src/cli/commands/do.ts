import { isConfidence, type Confidence } from '../../domain/entities.js';
import { runWorkflow, type WorkflowOptions } from '../../workflows/macros/run.js';
import { parseIntent } from '../../workflows/router.js';
import type { CliContext } from '../context.js';
import { runInteractiveDo } from '../do-interactive.js';
import { parseFlags } from '../parse-flags.js';

export async function runDoCommand(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  if (args.length === 0) {
    await runInteractiveDo(ctx.cwd);
    return;
  }

  const flags = parseFlags(args, {
    single: ['summary', 'next', 'from', 'to', 'session', 'confidence'],
    multi: [
      'done',
      'remaining',
      'warning',
      'question',
      'task-update',
      'project-update',
      'deferred',
      'discard',
    ],
  });

  const sentence = flags.positional.join(' ').trim();
  if (!sentence) {
    throw new Error(
      'A sentence command is required (or run "memorize do" with no arguments for interactive mode).',
    );
  }

  const confidenceRaw = flags.single.confidence;
  if (confidenceRaw && !isConfidence(confidenceRaw)) {
    throw new Error('--confidence must be one of low|medium|high.');
  }

  const options: WorkflowOptions = {
    ...(flags.single.summary ? { summary: flags.single.summary } : {}),
    ...(flags.single.next ? { nextAction: flags.single.next } : {}),
    ...(flags.single.from ? { fromActor: flags.single.from } : {}),
    ...(flags.single.to ? { toActor: flags.single.to } : {}),
    ...(flags.single.session ? { sessionId: flags.single.session } : {}),
    ...(confidenceRaw ? { confidence: confidenceRaw as Confidence } : {}),
    ...(flags.multi.done ? { doneItems: flags.multi.done } : {}),
    ...(flags.multi.remaining
      ? { remainingItems: flags.multi.remaining }
      : {}),
    ...(flags.multi.warning ? { warnings: flags.multi.warning } : {}),
    ...(flags.multi.question
      ? { unresolvedQuestions: flags.multi.question }
      : {}),
    ...(flags.multi['task-update']
      ? { taskUpdates: flags.multi['task-update'] }
      : {}),
    ...(flags.multi['project-update']
      ? { projectUpdates: flags.multi['project-update'] }
      : {}),
    ...(flags.multi.deferred
      ? { deferredItems: flags.multi.deferred }
      : {}),
    ...(flags.multi.discard
      ? { discardableItems: flags.multi.discard }
      : {}),
  };

  console.log(await runWorkflow(parseIntent(sentence), ctx.cwd, options));
}
