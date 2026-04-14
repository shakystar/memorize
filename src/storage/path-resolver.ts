import os from 'node:os';
import path from 'node:path';

export function getMemorizeRoot(): string {
  return process.env.MEMORIZE_ROOT ?? path.join(os.homedir(), '.memorize');
}

export function getProjectsRoot(): string {
  return path.join(getMemorizeRoot(), 'projects');
}

export function getProjectRoot(projectId: string): string {
  return path.join(getProjectsRoot(), projectId);
}

export function getProjectFile(projectId: string): string {
  return path.join(getProjectRoot(projectId), 'project.json');
}

export function getProjectBindingsFile(): string {
  return path.join(getMemorizeRoot(), 'profile', 'bindings.json');
}

export function getMemoryIndexFile(projectId: string): string {
  return path.join(getProjectRoot(projectId), 'memory-index.json');
}

export function getEventsFile(projectId: string, dateKey: string): string {
  return path.join(getProjectRoot(projectId), 'events', `${dateKey}.ndjson`);
}

export function getTaskFile(projectId: string, taskId: string): string {
  return path.join(getProjectRoot(projectId), 'tasks', `${taskId}.json`);
}

export function getWorkstreamFile(
  projectId: string,
  workstreamId: string,
): string {
  return path.join(
    getProjectRoot(projectId),
    'workstreams',
    `${workstreamId}.json`,
  );
}

export function getHandoffFile(projectId: string, handoffId: string): string {
  return path.join(getProjectRoot(projectId), 'handoffs', `${handoffId}.json`);
}

export function getCheckpointFile(
  projectId: string,
  checkpointId: string,
): string {
  return path.join(
    getProjectRoot(projectId),
    'checkpoints',
    `${checkpointId}.json`,
  );
}

export function getTopicsDir(projectId: string): string {
  return path.join(getProjectRoot(projectId), 'topics');
}

export function getTopicFile(projectId: string, topicId: string): string {
  return path.join(getTopicsDir(projectId), `${topicId}.md`);
}

export function getRuleFile(projectId: string, ruleId: string): string {
  return path.join(getProjectRoot(projectId), 'rules', `${ruleId}.json`);
}

export function getSyncFile(projectId: string): string {
  return path.join(getProjectRoot(projectId), 'sync', 'remote.json');
}

export function getConflictFile(projectId: string, conflictId: string): string {
  return path.join(
    getProjectRoot(projectId),
    'conflicts',
    `${conflictId}.json`,
  );
}
