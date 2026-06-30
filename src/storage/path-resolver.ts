import os from 'node:os';
import path from 'node:path';

import { assertValidId, isPersonalStoreId } from '../domain/common.js';

export function getMemorizeRoot(): string {
  return process.env.MEMORIZE_ROOT ?? path.join(os.homedir(), '.memorize');
}

export function getProjectsRoot(): string {
  return path.join(getMemorizeRoot(), 'projects');
}

/**
 * Host-level home of the global/personal memory store (Path A) — a SIBLING of
 * `projects/`, deliberately NOT under it, so the personal store never appears in
 * `listProjects()` (which reads `projects/`) and stays out of every project
 * enumeration sweep (refresh, setup, sync). One directory per account, mirroring
 * the #192 host-store pattern (`credentials`, `profile/`).
 */
export function getPersonalRoot(): string {
  return path.join(getMemorizeRoot(), 'personal');
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
  // The reserved personal store routes to its own host-level dir, outside
  // `projects/`. Every derived path (db file, sync, topics, locks) flows through
  // here, so this single redirect isolates the whole store with no other change.
  if (isPersonalStoreId(projectId)) return getPersonalRoot();
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

/**
 * Host-scoped sync credential store (#192), the git-credential analog: a single
 * `0600` JSON file keyed by normalized Hub host so `auth login` is run once per
 * host and later clone/sync carry no inline `--token`. Top-level (next to
 * `projects/` and `profile/`), like git's `~/.git-credentials`.
 */
export function getCredentialsFile(): string {
  return path.join(getMemorizeRoot(), 'credentials');
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

