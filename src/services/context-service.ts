import path from 'node:path';

import type {
  Conflict,
  OtherActiveTask,
  Rule,
  StartupContextPayload,
  Workstream,
} from '../domain/entities.js';
import { readJson, readJsonDir } from '../storage/fs-utils.js';
import {
  getMemoryIndexFile,
  getProjectRoot,
  getRuleFile,
  getWorkstreamFile,
} from '../storage/path-resolver.js';
import { freshnessLabel } from './freshness.js';
import {
  readDefaultWorkstreamForProject,
  readProject,
} from './project-service.js';
import { readActiveSessions } from './session-service.js';
import { readCheckpoint, readHandoff, readTask } from './task-service.js';

async function readOpenConflicts(projectId: string): Promise<Conflict[]> {
  const conflictsDir = path.join(getProjectRoot(projectId), 'conflicts');
  const conflicts = await readJsonDir<Conflict>(conflictsDir);
  return conflicts.filter((conflict) => conflict.status !== 'resolved');
}

async function readProjectRules(
  projectId: string,
  ruleIds: string[],
): Promise<Rule[]> {
  const rules = await Promise.all(
    ruleIds.map((ruleId) => readJson<Rule>(getRuleFile(projectId, ruleId))),
  );
  return rules.filter((rule): rule is Rule => Boolean(rule));
}

async function buildOtherActiveTasks(params: {
  projectId: string;
  selfTaskId?: string;
  selfSessionId?: string;
}): Promise<OtherActiveTask[]> {
  const sessions = await readActiveSessions(params.projectId);
  const otherSessions = sessions.filter((session) => {
    if (params.selfSessionId && session.id === params.selfSessionId) return false;
    if (!session.taskId) return false;
    if (params.selfTaskId && session.taskId === params.selfTaskId) return false;
    return true;
  });
  if (otherSessions.length === 0) return [];

  const tasks = await Promise.all(
    otherSessions.map(async (session) => {
      const task = await readTask(params.projectId, session.taskId!);
      if (!task) return undefined;
      return {
        id: task.id,
        title: task.title,
        status: task.status,
        assignment: {
          sessionId: session.id,
          actor: session.actor,
          lastSeenAt: session.lastSeenAt,
          freshness: freshnessLabel(session.lastSeenAt),
        },
      } satisfies OtherActiveTask;
    }),
  );
  return tasks.filter((entry): entry is OtherActiveTask => Boolean(entry));
}

export async function loadStartContext(params: {
  projectId: string;
  workstreamId?: string;
  taskId?: string;
  selfSessionId?: string;
}): Promise<StartupContextPayload> {
  const project = await readProject(params.projectId);
  if (!project) {
    throw new Error(`Project ${params.projectId} not found`);
  }

  const memoryIndex = await readJson<{
    shortSummary: string;
    mustReadTopics: Array<{ id: string; title: string; path: string }>;
  }>(getMemoryIndexFile(params.projectId));

  const workstream = params.workstreamId
    ? await readJson<Workstream>(
        getWorkstreamFile(params.projectId, params.workstreamId),
      )
    : await readDefaultWorkstreamForProject(project);

  let task = params.taskId
    ? await readTask(params.projectId, params.taskId)
    : undefined;

  if (!task) {
    const candidateTasks = (
      await Promise.all(
        project.activeTaskIds.map((taskId) =>
          readTask(params.projectId, taskId),
        ),
      )
    ).filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));

    task =
      candidateTasks.find((candidate) => candidate.status === 'in_progress') ??
      candidateTasks.find((candidate) => candidate.status === 'handoff_ready') ??
      candidateTasks[0];
  }
  const latestHandoff =
    task?.latestHandoffId
      ? await readHandoff(params.projectId, task.latestHandoffId)
      : undefined;
  const latestCheckpoint =
    task?.latestCheckpointId
      ? await readCheckpoint(params.projectId, task.latestCheckpointId)
      : undefined;
  const rules = await readProjectRules(params.projectId, project.ruleIds);

  const otherActiveTasks = await buildOtherActiveTasks({
    projectId: params.projectId,
    ...(task?.id ? { selfTaskId: task.id } : {}),
    ...(params.selfSessionId ? { selfSessionId: params.selfSessionId } : {}),
  });

  return {
    projectSummary: memoryIndex?.shortSummary ?? project.summary,
    projectRules: rules.map((rule) => `${rule.title}: ${rule.body}`),
    ...(workstream?.summary
      ? { workstreamSummary: workstream.summary }
      : {}),
    ...(task ? { task } : {}),
    ...(latestHandoff ? { latestHandoff } : {}),
    ...(latestCheckpoint ? { latestCheckpoint } : {}),
    openConflicts: await readOpenConflicts(params.projectId),
    mustReadTopics: memoryIndex?.mustReadTopics ?? [],
    ...(otherActiveTasks.length > 0 ? { otherActiveTasks } : {}),
  };
}
