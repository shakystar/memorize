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

export function getProjectRoot(projectId: string): string {
  assertValidId(projectId, 'projectId');
  const projectsRoot = getProjectsRoot();
  return ensureWithinRoot(path.join(projectsRoot, projectId), projectsRoot);
}

export function getProjectDbFile(projectId: string): string {
  const projectRoot = getProjectRoot(projectId);
  return ensureWithinRoot(path.join(projectRoot, 'memorize.db'), projectRoot);
}

export function getProjectBindingsFile(): string {
  return path.join(getMemorizeRoot(), 'profile', 'bindings.json');
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

export function getSyncFile(projectId: string): string {
  const projectRoot = getProjectRoot(projectId);
  return ensureWithinRoot(
    path.join(projectRoot, 'sync', 'remote.json'),
    projectRoot,
  );
}

