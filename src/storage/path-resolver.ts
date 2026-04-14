import os from 'node:os';
import path from 'node:path';

import { assertValidId } from '../domain/common.js';

export function getMemorizeRoot(): string {
  return process.env.MEMORIZE_ROOT ?? path.join(os.homedir(), '.memorize');
}

export function getProjectsRoot(): string {
  return path.join(getMemorizeRoot(), 'projects');
}

function ensureWithinRoot(candidate: string, root: string): string {
  const candidateAbs = path.resolve(candidate);
  const rootAbs = path.resolve(root);
  if (
    candidateAbs !== rootAbs &&
    !candidateAbs.startsWith(rootAbs + path.sep)
  ) {
    throw new Error(
      `Path escapes expected root: ${candidateAbs} is outside ${rootAbs}`,
    );
  }
  return candidateAbs;
}

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function assertValidDateKey(value: string): void {
  if (!DATE_KEY_PATTERN.test(value)) {
    throw new Error(`Invalid events date key: ${JSON.stringify(value)}`);
  }
}

export function getProjectRoot(projectId: string): string {
  assertValidId(projectId, 'projectId');
  const projectsRoot = getProjectsRoot();
  return ensureWithinRoot(path.join(projectsRoot, projectId), projectsRoot);
}

export function getProjectFile(projectId: string): string {
  const projectRoot = getProjectRoot(projectId);
  return ensureWithinRoot(path.join(projectRoot, 'project.json'), projectRoot);
}

export function getProjectBindingsFile(): string {
  return path.join(getMemorizeRoot(), 'profile', 'bindings.json');
}

export function getMemoryIndexFile(projectId: string): string {
  const projectRoot = getProjectRoot(projectId);
  return ensureWithinRoot(
    path.join(projectRoot, 'memory-index.json'),
    projectRoot,
  );
}

export function getEventsFile(projectId: string, dateKey: string): string {
  assertValidDateKey(dateKey);
  const projectRoot = getProjectRoot(projectId);
  return ensureWithinRoot(
    path.join(projectRoot, 'events', `${dateKey}.ndjson`),
    projectRoot,
  );
}

export function getTaskFile(projectId: string, taskId: string): string {
  assertValidId(taskId, 'taskId');
  const projectRoot = getProjectRoot(projectId);
  return ensureWithinRoot(
    path.join(projectRoot, 'tasks', `${taskId}.json`),
    projectRoot,
  );
}

export function getWorkstreamFile(
  projectId: string,
  workstreamId: string,
): string {
  assertValidId(workstreamId, 'workstreamId');
  const projectRoot = getProjectRoot(projectId);
  return ensureWithinRoot(
    path.join(projectRoot, 'workstreams', `${workstreamId}.json`),
    projectRoot,
  );
}

export function getHandoffFile(projectId: string, handoffId: string): string {
  assertValidId(handoffId, 'handoffId');
  const projectRoot = getProjectRoot(projectId);
  return ensureWithinRoot(
    path.join(projectRoot, 'handoffs', `${handoffId}.json`),
    projectRoot,
  );
}

export function getCheckpointFile(
  projectId: string,
  checkpointId: string,
): string {
  assertValidId(checkpointId, 'checkpointId');
  const projectRoot = getProjectRoot(projectId);
  return ensureWithinRoot(
    path.join(projectRoot, 'checkpoints', `${checkpointId}.json`),
    projectRoot,
  );
}

export function getTopicsDir(projectId: string): string {
  const projectRoot = getProjectRoot(projectId);
  return ensureWithinRoot(path.join(projectRoot, 'topics'), projectRoot);
}

export function getTopicFile(projectId: string, topicId: string): string {
  assertValidId(topicId, 'topicId');
  const topicsDir = getTopicsDir(projectId);
  return ensureWithinRoot(path.join(topicsDir, `${topicId}.md`), topicsDir);
}

export function getRuleFile(projectId: string, ruleId: string): string {
  assertValidId(ruleId, 'ruleId');
  const projectRoot = getProjectRoot(projectId);
  return ensureWithinRoot(
    path.join(projectRoot, 'rules', `${ruleId}.json`),
    projectRoot,
  );
}

export function getSyncFile(projectId: string): string {
  const projectRoot = getProjectRoot(projectId);
  return ensureWithinRoot(
    path.join(projectRoot, 'sync', 'remote.json'),
    projectRoot,
  );
}

export function getSyncInboundFile(projectId: string): string {
  const projectRoot = getProjectRoot(projectId);
  return ensureWithinRoot(
    path.join(projectRoot, 'sync', 'inbound.ndjson'),
    projectRoot,
  );
}

export function getConflictFile(projectId: string, conflictId: string): string {
  assertValidId(conflictId, 'conflictId');
  const projectRoot = getProjectRoot(projectId);
  return ensureWithinRoot(
    path.join(projectRoot, 'conflicts', `${conflictId}.json`),
    projectRoot,
  );
}
