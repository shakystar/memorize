import fs from 'node:fs/promises';

import path from 'node:path';

import { appendEvent, ensureProjectDirectories } from '../storage/event-store.js';
import {
  bindProject,
  readBindings,
  resolveProjectIdForPath,
  unbindPath,
} from '../storage/bindings-store.js';
import { isEnoent, readJson, writeJson } from '../storage/fs-utils.js';
import {
  getProjectProjection,
  getWorkstream,
  rebuildProjectProjection,
} from './projection-store.js';
import { ACTOR_SYSTEM } from '../domain/common.js';
import type { CreateProjectInput } from '../domain/commands.js';
import { createProject as createProjectEntity, createWorkstream } from '../domain/entities.js';
import type { Project, ProjectSyncState, Workstream } from '../domain/entities.js';
import { getProjectsRoot, getSyncFile } from '../storage/path-resolver.js';

export async function createProject(input: CreateProjectInput): Promise<Project> {
  const project = createProjectEntity(input);
  const defaultWorkstream = createWorkstream({
    projectId: project.id,
    title: 'default',
    summary: 'Default workstream',
  });

  project.activeWorkstreamIds = [defaultWorkstream.id];

  const syncState: ProjectSyncState = {
    id: `sync_${project.id}`,
    schemaVersion: project.schemaVersion,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    projectId: project.id,
    syncEnabled: false,
    syncStatus: 'idle',
  };

  await ensureProjectDirectories(project.id);
  await appendEvent({
    type: 'project.created',
    projectId: project.id,
    scopeType: 'project',
    scopeId: project.id,
    actor: ACTOR_SYSTEM,
    payload: project,
  });
  await appendEvent({
    type: 'workstream.created',
    projectId: project.id,
    scopeType: 'workstream',
    scopeId: defaultWorkstream.id,
    actor: ACTOR_SYSTEM,
    payload: defaultWorkstream,
  });
  await rebuildProjectProjection(project.id);
  await writeJson(getSyncFile(project.id), syncState);
  await bindProject(input.rootPath, project.id);
  return project;
}

export async function getBoundProjectId(
  rootPath: string,
): Promise<string | undefined> {
  return resolveProjectIdForPath(rootPath);
}

export async function ensureBoundProjectId(cwd: string): Promise<string> {
  const existing = await getBoundProjectId(cwd);
  if (existing) return existing;
  const { setupProject } = await import('./setup-service.js');
  const setup = await setupProject(cwd);
  return setup.project.id;
}

export async function requireBoundProjectId(rootPath: string): Promise<string> {
  const projectId = await getBoundProjectId(rootPath);
  if (!projectId) {
    throw new Error('No project bound to current directory.');
  }
  return projectId;
}

export async function readProject(projectId: string): Promise<Project | undefined> {
  return getProjectProjection(projectId);
}

export async function readDefaultWorkstreamForProject(
  project: Project,
): Promise<Workstream | undefined> {
  const workstreamId = project.activeWorkstreamIds[0];
  if (!workstreamId) {
    return undefined;
  }
  return getWorkstream(project.id, workstreamId);
}

export async function readDefaultWorkstream(
  projectId: string,
): Promise<Workstream | undefined> {
  const project = await readProject(projectId);
  if (!project) return undefined;
  return readDefaultWorkstreamForProject(project);
}

export async function resolveActiveTaskId(
  projectId: string,
  explicit?: string,
): Promise<string | undefined> {
  if (explicit?.trim()) return explicit.trim();
  const project = await readProject(projectId);
  return project?.activeTaskIds[0];
}

export async function readSyncState(
  projectId: string,
): Promise<ProjectSyncState | undefined> {
  return readJson<ProjectSyncState>(getSyncFile(projectId));
}

/**
 * Enumerate every project known to this machine (machine-wide refresh,
 * `memorize update`). Reads the projections under ~/.memorize/projects/*;
 * entries that are not readable projects (stray files, invalid ids, dirs
 * without a project row) are silently skipped.
 */
/**
 * Resolve symlinks in a path when it exists on disk, falling back to the input
 * unchanged when it does not. Bindings are keyed under the canonical (realpath)
 * form that the OS gives back for process.cwd(); this keeps argument-supplied
 * paths in that same form without throwing on paths that are already gone.
 */
async function realpathIfExists(absPath: string): Promise<string> {
  try {
    return await fs.realpath(absPath);
  } catch (error) {
    if (isEnoent(error)) return absPath;
    throw error;
  }
}

/**
 * Relocate an existing project binding to a new absolute root path (#124).
 *
 * Moving an adopted repo to a different path (e.g. machine migration) would
 * otherwise make `project setup` mint a brand-new empty project at the new
 * path, orphaning the original project's memory. Relocate rebinds the SAME
 * project id to the new path so the project — and all its memory under
 * `~/.memorize/projects/<id>/` — resolves at the new location instead.
 *
 * Identify the source project either by `projectId` or by its current/old
 * `fromPath`. The new path must exist on disk and must not already be bound to
 * a DIFFERENT project. Re-running with a path already bound to the same project
 * is a clean no-op. The project's stored `rootPath` is updated to match, and
 * any stale binding entries for the same project (the old path) are removed.
 */
export async function relocateProject(input: {
  newPath: string;
  projectId?: string;
  fromPath?: string;
}): Promise<{ project: Project; alreadyBound: boolean }> {
  const requestedPath = path.resolve(input.newPath);

  // The target directory must actually exist — relocating onto a missing path
  // would just recreate the original orphaning at a new location.
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(requestedPath);
  } catch (error) {
    if (isEnoent(error)) {
      throw new Error(`New path does not exist on disk: ${requestedPath}`);
    }
    throw error;
  }
  if (!stat.isDirectory()) {
    throw new Error(`New path is not a directory: ${requestedPath}`);
  }

  // Canonicalize through realpath so the binding key matches what cwd-derived
  // lookups (`project show`, `getBoundProjectId(process.cwd())`) produce. The
  // OS realpaths process.cwd(), so on platforms where the parent is a symlink
  // (macOS tmpdir: /var -> /private/var) a path.resolve-only key would sit at a
  // location no cwd lookup ever yields, and the relocated project would resolve
  // as unbound. The directory is guaranteed to exist by the stat above. (#124)
  const newPath = await fs.realpath(requestedPath);

  // Resolve which existing project to rebind.
  let projectId: string | undefined;
  if (input.projectId) {
    projectId = input.projectId;
  } else if (input.fromPath) {
    // Match the same canonical form bindings are keyed under. The old path may
    // already be gone (the repo moved), so realpath only when it still exists;
    // otherwise fall back to path.resolve.
    const fromPath = await realpathIfExists(path.resolve(input.fromPath));
    projectId = await getBoundProjectId(fromPath);
    if (!projectId) {
      throw new Error(`No project is bound to --from path: ${fromPath}`);
    }
  } else {
    throw new Error('Specify the source project with --project <id> or --from <oldPath>.');
  }

  const project = await readProject(projectId);
  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  // Guard against hijacking a path that belongs to a different project. An
  // exact-path binding to the SAME project is the idempotent no-op case.
  const bindings = await readBindings();
  const occupant = bindings.byPath[newPath];
  if (occupant && occupant !== projectId) {
    throw new Error(
      `New path is already bound to a different project (${occupant}): ${newPath}`,
    );
  }

  const alreadyBound = occupant === projectId && project.rootPath === newPath;

  // Rebind: point the new path at this project id and drop any prior path
  // bindings for the same project so the stale location can't silently re-adopt
  // or split memory.
  await bindProject(newPath, projectId);
  for (const [boundPath, boundId] of Object.entries(bindings.byPath)) {
    if (boundId === projectId && boundPath !== newPath) {
      await unbindPath(boundPath);
    }
  }

  // Keep the project's stored rootPath in sync with the binding.
  if (project.rootPath !== newPath) {
    await appendEvent({
      type: 'project.updated',
      projectId,
      scopeType: 'project',
      scopeId: projectId,
      actor: ACTOR_SYSTEM,
      payload: { rootPath: newPath } satisfies Partial<Project>,
    });
    await rebuildProjectProjection(projectId);
  }

  const refreshed = (await readProject(projectId)) ?? project;
  return { project: refreshed, alreadyBound };
}

export async function listProjects(): Promise<Project[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(getProjectsRoot());
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const projects: Project[] = [];
  for (const id of entries) {
    try {
      const project = getProjectProjection(id);
      if (project) projects.push(project);
    } catch {
      // not a project dir — skip
    }
  }
  return projects;
}
