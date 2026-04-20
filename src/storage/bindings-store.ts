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
