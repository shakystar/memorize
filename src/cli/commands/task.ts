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
import { resolveSessionContext } from '../../services/session-context.js';
import { getCurrentSessionId } from '../../services/session-service.js';
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
  ctx: CliContext,
  projectId: string,
): Promise<void> {
  // Round-3 dogfood finding (codex session 4): `memorize task resume`
  // showed the project's first active task instead of the calling
  // session's claimed task — the same Gap A pattern the handoff CLI
  // had before rc.7. The fix mirrors what runHandoffTask does: ask
  // the SSoT for the calling session, and pin both selfSessionId
  // (so the picker excludes us from otherActiveTasks) and taskId
  // (so we get OUR task back, not whatever happens to be first).
  const sessionCtx = await resolveSessionContext(ctx.cwd);
  const payload = await loadStartContext({
    projectId,
    ...(sessionCtx.taskId ? { taskId: sessionCtx.taskId } : {}),
    ...(sessionCtx.sessionId ? { selfSessionId: sessionCtx.sessionId } : {}),
  });
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
  // project-wide activeTaskIds[0] fallback. Single resolver call
  // — see services/session-context.ts for the priority chain
  // (env → agent-pid → tty → opt-in most-recent).
  const sessionCtx = await resolveSessionContext(ctx.cwd);
  const resolvedTaskId =
    flags.single.task?.trim() ??
    sessionCtx.taskId ??
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
  // Single resolver call — taskId and actor share the same session
  // pointer, so we ask once and read both. The fallback chain lives
  // in `resolveSessionContext` (env → agent-pid → tty → opt-in
  // most-recent); the rc.6 codex Gap A leak happened because the CLI
  // had its own simpler chain that lacked the agent-pid hop.
  const sessionCtx = await resolveSessionContext(ctx.cwd);
  const resolvedTaskId =
    flags.single.task?.trim() ??
    sessionCtx.taskId ??
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
  const fromActor =
    flags.single.from ?? sessionCtx.actor ?? ACTOR_USER;
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
