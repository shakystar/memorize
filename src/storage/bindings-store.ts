import path from 'node:path';

import { readJson, writeJson } from './fs-utils.js';
import { getProjectBindingsFile } from './path-resolver.js';

export interface ProjectBindings {
  byPath: Record<string, string>;
}

function normalizeRoot(rootPath: string): string {
  return path.resolve(rootPath);
}

export async function readBindings(): Promise<ProjectBindings> {
  return (await readJson<ProjectBindings>(getProjectBindingsFile())) ?? {
    byPath: {},
  };
}

export async function bindProject(rootPath: string, projectId: string): Promise<void> {
  const bindings = await readBindings();
  bindings.byPath[normalizeRoot(rootPath)] = projectId;
  await writeJson(getProjectBindingsFile(), bindings);
}

export async function unbindPath(rootPath: string): Promise<void> {
  const bindings = await readBindings();
  const key = normalizeRoot(rootPath);
  if (key in bindings.byPath) {
    delete bindings.byPath[key];
    await writeJson(getProjectBindingsFile(), bindings);
  }
}

export async function resolveProjectIdForPath(
  rootPath: string,
): Promise<string | undefined> {
  const bindings = await readBindings();
  let current = normalizeRoot(rootPath);
  while (true) {
    const projectId = bindings.byPath[current];
    if (projectId) return projectId;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Reverse of {@link resolveProjectIdForPath}: find a bound folder path for a
 * projectId. Genesis backfill uses this to recover a store's rootPath/title
 * when the `project.created` event is missing. Returns the first bound path.
 */
export async function getPathForProject(
  projectId: string,
): Promise<string | undefined> {
  const bindings = await readBindings();
  for (const [boundPath, id] of Object.entries(bindings.byPath)) {
    if (id === projectId) return boundPath;
  }
  return undefined;
}

export interface BindingMatch {
  projectId: string;
  matchedPath: string;
  kind: 'exact' | 'ancestor';
}

/**
 * Like {@link resolveProjectIdForPath} but distinguishes an EXACT binding (this
 * path IS a bound project root) from an ANCESTOR binding (this path merely sits
 * inside a bound project). Binding-CREATION commands (`project setup`/`init`)
 * need this so they don't silently absorb a subdirectory into its parent (#151).
 * Operational commands keep using the walk-up resolver above.
 */
export async function resolveBindingForPath(
  rootPath: string,
): Promise<BindingMatch | undefined> {
  const bindings = await readBindings();
  const start = normalizeRoot(rootPath);
  let current = start;
  while (true) {
    const projectId = bindings.byPath[current];
    if (projectId) {
      return {
        projectId,
        matchedPath: current,
        kind: current === start ? 'exact' : 'ancestor',
      };
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
