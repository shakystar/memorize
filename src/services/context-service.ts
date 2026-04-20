import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  Conflict,
  Rule,
  StartupContextPayload,
  Workstream,
} from '../domain/entities.js';
import { isEnoent, readJson } from '../storage/fs-utils.js';
import {
  getMemoryIndexFile,
  getProjectRoot,
  getRuleFile,
  getWorkstreamFile,
} from '../storage/path-resolver.js';
import {
  readDefaultWorkstreamForProject,
  readProject,
} from './project-service.js';
import { readHandoff, readTask } from './task-service.js';

async function readOpenConflicts(projectId: string): Promise<Conflict[]> {
  const conflictsDir = path.join(getProjectRoot(projectId), 'conflicts');
  try {
    const entries = (await fs.readdir(conflictsDir))
      .filter((entry) => entry.endsWith('.json'))
      .sort();
    const conflicts = await Promise.all(
      entries.map((entry) => readJson<Conflict>(path.join(conflictsDir, entry))),
    );
    return conflicts.filter(
      (conflict): conflict is Conflict =>
        Boolean(conflict && conflict.status !== 'resolved'),
    );
  } catch (error) {
    if (isEnoent(error)) {
      return [];
    }
    throw error;
  }
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

export async function loadStartContext(params: {
  projectId: string;
  workstreamId?: string;
  taskId?: string;
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
  const rules = await readProjectRules(params.projectId, project.ruleIds);

  return {
    projectSummary: memoryIndex?.shortSummary ?? project.summary,
    projectRules: rules.map((rule) => `${rule.title}: ${rule.body}`),
    ...(workstream?.summary
      ? { workstreamSummary: workstream.summary }
      : {}),
    ...(task ? { task } : {}),
    ...(latestHandoff ? { latestHandoff } : {}),
    openConflicts: await readOpenConflicts(params.projectId),
    mustReadTopics: memoryIndex?.mustReadTopics ?? [],
  };
}
