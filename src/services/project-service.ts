import { appendEvent, ensureProjectDirectories } from '../storage/event-store.js';
import { bindProject, resolveProjectIdForPath } from '../storage/bindings-store.js';
import { getProjectFile, getWorkstreamFile } from '../storage/path-resolver.js';
import { readJson, writeJson } from '../storage/fs-utils.js';
import { rebuildProjectProjection } from './projection-store.js';
import { ACTOR_SYSTEM } from '../domain/common.js';
import type { CreateProjectInput } from '../domain/commands.js';
import { createProject as createProjectEntity, createWorkstream } from '../domain/entities.js';
import type { Project, ProjectSyncState, Workstream } from '../domain/entities.js';
import { getSyncFile } from '../storage/path-resolver.js';

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
  return readJson<Project>(getProjectFile(projectId));
}

export async function readDefaultWorkstreamForProject(
  project: Project,
): Promise<Workstream | undefined> {
  const workstreamId = project.activeWorkstreamIds[0];
  if (!workstreamId) {
    return undefined;
  }
  return readJson<Workstream>(getWorkstreamFile(project.id, workstreamId));
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
