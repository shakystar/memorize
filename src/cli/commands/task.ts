import { ACTOR_NEXT_AGENT, ACTOR_USER } from '../../domain/common.js';
import {
  isConfidence,
  type Confidence,
  type Task,
} from '../../domain/entities.js';
import { loadStartContext } from '../../services/context-service.js';
import {
  requireBoundProjectId,
  resolveActiveTaskId,
} from '../../services/project-service.js';
import {
  getCurrentSessionActor,
  getCurrentSessionId,
  getCurrentSessionTaskId,
} from '../../services/session-service.js';
import {
  createCheckpoint,
  createHandoff,
  createTask,
  listTasks,
  readTask,
} from '../../services/task-service.js';
import type { CliContext } from '../context.js';
import { parseFlags } from '../parse-flags.js';
import { renderScaffoldUsage } from '../usage.js';

const HANDOFF_INTENT_NOTICE = [
  'Note: Handoff records intent, context, and decisions only —',
  '      not code state. The next agent verifies tests and git',
  '      state independently at session start.',
].join('\n');

const ALLOWED_STATUSES: Task['status'][] = [
  'todo',
  'in_progress',
  'blocked',
  'handoff_ready',
  'done',
];

type TaskHandler = (
  args: string[],
  ctx: CliContext,
  projectId: string,
) => Promise<void>;

async function runCreateTask(
  args: string[],
  _ctx: CliContext,
  projectId: string,
): Promise<void> {
  const title = args.join(' ').trim();
  if (!title) throw new Error('Task title is required.');
  const task = await createTask({
    projectId,
    title,
    description: title,
    actor: ACTOR_USER,
  });
  console.log(`Created task ${task.id}`);
}

async function runShowTask(
  args: string[],
  _ctx: CliContext,
  projectId: string,
): Promise<void> {
  const taskId = args[0];
  if (!taskId) throw new Error('Task id is required.');
  const task = await readTask(projectId, taskId);
  console.log(JSON.stringify(task, null, 2));
}

async function runListTasks(
  args: string[],
  _ctx: CliContext,
  projectId: string,
): Promise<void> {
  const flags = parseFlags(args, { single: ['status', 'workstream'] });
  const status = flags.single.status as Task['status'] | undefined;
  if (status && !ALLOWED_STATUSES.includes(status)) {
    throw new Error(`--status must be one of ${ALLOWED_STATUSES.join('|')}.`);
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
    console.log(`${task.id}\t${task.status}\t${task.priority}\t${task.title}`);
  }
}

async function runResumeTask(
  _args: string[],
  _ctx: CliContext,
  projectId: string,
): Promise<void> {
  const payload = await loadStartContext({ projectId });
  console.log(JSON.stringify(payload, null, 2));
}

async function runCheckpointTask(
  args: string[],
  ctx: CliContext,
  projectId: string,
): Promise<void> {
  const flags = parseFlags(args, {
    single: ['summary', 'session', 'task'],
    multi: ['task-update', 'project-update', 'deferred', 'discard'],
  });
  // Prefer the task this session claimed at SessionStart over the
  // project-wide activeTaskIds[0] fallback. Without this the rc.6
  // dogfood saw codex checkpoints land on whichever task happened
  // to be first in the project's active list (Gap A leaked through
  // the CLI surface even after the hook handler was patched).
  const resolvedTaskId =
    flags.single.task?.trim() ??
    (await getCurrentSessionTaskId(ctx.cwd)) ??
    (await resolveActiveTaskId(projectId));
  const summary = flags.single.summary;
  if (!summary) throw new Error('--summary is required for task checkpoint.');
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
    ...(flags.multi.deferred ? { deferredItems: flags.multi.deferred } : {}),
    ...(flags.multi.discard
      ? { discardableItems: flags.multi.discard }
      : {}),
  });
  console.log(`Created checkpoint ${checkpoint.id}`);
}

async function runHandoffTask(
  args: string[],
  ctx: CliContext,
  projectId: string,
): Promise<void> {
  const flags = parseFlags(args, {
    single: ['summary', 'next', 'from', 'to', 'task', 'confidence'],
    multi: ['done', 'remaining', 'warning', 'question'],
  });
  // Session-aware fallback chain (Gap A fix at the CLI surface):
  //   --task arg → session-claimed task → project's first active task.
  // The middle hop is what was missing in rc.6 — without it, every
  // codex handoff in a multi-session cwd attached itself to whichever
  // task was first in project.activeTaskIds, regardless of which
  // task the calling session actually claimed.
  const resolvedTaskId =
    flags.single.task?.trim() ??
    (await getCurrentSessionTaskId(ctx.cwd)) ??
    (await resolveActiveTaskId(projectId));
  if (!resolvedTaskId) {
    throw new Error(
      'Handoff requires a taskId (pass --task or ensure an active task exists).',
    );
  }
  const summary = flags.single.summary;
  const nextAction = flags.single.next;
  if (!summary) throw new Error('--summary is required for task handoff.');
  if (!nextAction) throw new Error('--next is required for task handoff.');
  const confidenceRaw = flags.single.confidence;
  if (confidenceRaw && !isConfidence(confidenceRaw)) {
    throw new Error('--confidence must be one of low|medium|high.');
  }
  const confidence = confidenceRaw as Confidence | undefined;
  // fromActor fallback: --from arg → session's startedBy → ACTOR_USER.
  // Without the middle hop, a handoff issued from inside a codex
  // session reads as `fromActor: "user"`, erasing the audit trail of
  // which agent actually did the work.
  const fromActor =
    flags.single.from ?? (await getCurrentSessionActor(ctx.cwd)) ?? ACTOR_USER;
  const handoff = await createHandoff({
    projectId,
    taskId: resolvedTaskId,
    fromActor,
    toActor: flags.single.to ?? ACTOR_NEXT_AGENT,
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
}

const taskHandlers: Record<string, TaskHandler> = {
  create: runCreateTask,
  show: runShowTask,
  list: runListTasks,
  resume: runResumeTask,
  start: runResumeTask,
  checkpoint: runCheckpointTask,
  handoff: runHandoffTask,
};

export async function runTaskCommand(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  const projectId = await requireBoundProjectId(ctx.cwd);
  const subcommand = args[0];
  const handler = subcommand ? taskHandlers[subcommand] : undefined;
  if (!handler) {
    console.log(renderScaffoldUsage());
    return;
  }
  await handler(args.slice(1), ctx, projectId);
}
