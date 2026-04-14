import type { Task } from '../../domain/entities.js';
import { loadStartContext } from '../../services/context-service.js';
import {
  getBoundProjectId,
  readProject,
} from '../../services/project-service.js';
import { getCurrentSessionId } from '../../services/session-service.js';
import {
  createCheckpoint,
  createHandoff,
  createTask,
  listTasks,
  readTask,
} from '../../services/task-service.js';
import { HANDOFF_INTENT_NOTICE } from '../../workflows/macros/handoff-task.js';
import type { CliContext } from '../context.js';
import { parseFlags } from '../parse-flags.js';
import { renderScaffoldUsage } from '../usage.js';

async function resolveTaskId(
  projectId: string,
  explicit: string | undefined,
): Promise<string | undefined> {
  if (explicit) return explicit;
  const project = await readProject(projectId);
  return project?.activeTaskIds[0];
}

const ALLOWED_STATUSES: Task['status'][] = [
  'todo',
  'in_progress',
  'blocked',
  'handoff_ready',
  'done',
];

export async function runTaskCommand(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  const projectId = await getBoundProjectId(ctx.cwd);
  if (!projectId) throw new Error('No project bound to current directory.');
  const subcommand = args[0];

  if (subcommand === 'create') {
    const title = args.slice(1).join(' ').trim();
    if (!title) throw new Error('Task title is required.');
    const task = await createTask({
      projectId,
      title,
      description: title,
      actor: 'user',
    });
    console.log(`Created task ${task.id}`);
    return;
  }

  if (subcommand === 'show') {
    const taskId = args[1];
    if (!taskId) throw new Error('Task id is required.');
    const task = await readTask(projectId, taskId);
    console.log(JSON.stringify(task, null, 2));
    return;
  }

  if (subcommand === 'list') {
    const flags = parseFlags(args.slice(1), {
      single: ['status', 'workstream'],
    });
    const status = flags.single.status as Task['status'] | undefined;
    if (status && !ALLOWED_STATUSES.includes(status)) {
      throw new Error(
        `--status must be one of ${ALLOWED_STATUSES.join('|')}.`,
      );
    }
    const tasks = await listTasks(projectId, {
      ...(status ? { status } : {}),
      ...(flags.single.workstream
        ? { workstreamId: flags.single.workstream }
        : {}),
    });
    if (tasks.length === 0) {
      console.log('No tasks found.');
      return;
    }
    for (const task of tasks) {
      console.log(
        `${task.id}\t${task.status}\t${task.priority}\t${task.title}`,
      );
    }
    return;
  }

  if (subcommand === 'resume' || subcommand === 'start') {
    const payload = await loadStartContext({ projectId });
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (subcommand === 'checkpoint') {
    const flags = parseFlags(args.slice(1), {
      single: ['summary', 'session', 'task'],
      multi: ['task-update', 'project-update', 'deferred', 'discard'],
    });
    const taskId = flags.single.task ?? flags.positional[0];
    const resolvedTaskId = await resolveTaskId(projectId, taskId);
    const summary = flags.single.summary;
    if (!summary)
      throw new Error('--summary is required for task checkpoint.');
    const sessionId =
      flags.single.session ?? (await getCurrentSessionId(ctx.cwd));
    const checkpoint = await createCheckpoint({
      projectId,
      sessionId,
      ...(resolvedTaskId ? { taskId: resolvedTaskId } : {}),
      summary,
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
    });
    console.log(`Created checkpoint ${checkpoint.id}`);
    return;
  }

  if (subcommand === 'handoff') {
    const flags = parseFlags(args.slice(1), {
      single: ['summary', 'next', 'from', 'to', 'task', 'confidence'],
      multi: ['done', 'remaining', 'warning', 'question'],
    });
    const taskId = flags.single.task ?? flags.positional[0];
    const resolvedTaskId = await resolveTaskId(projectId, taskId);
    if (!resolvedTaskId) {
      throw new Error(
        'Handoff requires a taskId (pass as positional, --task, or ensure an active task exists).',
      );
    }
    const summary = flags.single.summary;
    const nextAction = flags.single.next;
    if (!summary) throw new Error('--summary is required for task handoff.');
    if (!nextAction) throw new Error('--next is required for task handoff.');
    const confidenceRaw = flags.single.confidence;
    if (
      confidenceRaw &&
      !['low', 'medium', 'high'].includes(confidenceRaw)
    ) {
      throw new Error('--confidence must be one of low|medium|high.');
    }
    const confidence = confidenceRaw as
      | 'low'
      | 'medium'
      | 'high'
      | undefined;
    const handoff = await createHandoff({
      projectId,
      taskId: resolvedTaskId,
      fromActor: flags.single.from ?? 'user',
      toActor: flags.single.to ?? 'next-agent',
      summary,
      nextAction,
      ...(flags.multi.done ? { doneItems: flags.multi.done } : {}),
      ...(flags.multi.remaining
        ? { remainingItems: flags.multi.remaining }
        : {}),
      ...(flags.multi.warning ? { warnings: flags.multi.warning } : {}),
      ...(flags.multi.question
        ? { unresolvedQuestions: flags.multi.question }
        : {}),
      ...(confidence ? { confidence } : {}),
    });
    console.log(`Created handoff ${handoff.id}\n\n${HANDOFF_INTENT_NOTICE}`);
    return;
  }

  console.log(renderScaffoldUsage());
}
