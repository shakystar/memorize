import fs from 'node:fs/promises';

import {
  appendEvent,
  appendEvents,
  ensureProjectDirectories,
} from '../storage/event-store.js';
import { bindProject, resolveProjectIdForPath } from '../storage/bindings-store.js';
import { isEnoent, readJson, writeJson } from '../storage/fs-utils.js';
import {
  getProjectProjection,
  getWorkstream,
  rebuildProjectProjection,
} from './projection-store.js';
import { ACTOR_SYSTEM } from '../domain/common.js';
import type { CreateProjectInput } from '../domain/commands.js';
import {
  createDecision as createDecisionEntity,
  createProject as createProjectEntity,
  createWorkstream,
} from '../domain/entities.js';
import type {
  Decision,
  Project,
  ProjectSyncState,
  Workstream,
} from '../domain/entities.js';
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

/**
 * Record a project decision. The events `decision.proposed` / `decision.accepted`
 * and their projection were modeled but had no producer (Bug #121), so decisions
 * could never be logged. MVP: a recorded decision is immediately accepted (the
 * common "log a decision we already made" case), emitting both events as one
 * atomic batch so `acceptedDecisionIds` / `recentDecisions` reflect it. The
 * projector keys `state.decisions` by the EVENT scopeId, so it must be the
 * decision id for distinct decisions to survive.
 */
export async function recordDecision(input: {
  projectId: string;
  title: string;
  decision: string;
  rationale?: string;
  actor?: string;
}): Promise<Decision> {
  const actor = input.actor ?? ACTOR_SYSTEM;
  const decision = createDecisionEntity({
    scopeType: 'project',
    scopeId: input.projectId,
    title: input.title,
    decision: input.decision,
    rationale: input.rationale ?? '',
    createdBy: actor,
  });
  const accepted: Decision = { ...decision, status: 'accepted' };
  await appendEvents(input.projectId, [
    {
      type: 'decision.proposed',
      projectId: input.projectId,
      scopeType: 'project',
      scopeId: decision.id,
      actor,
      payload: decision,
    },
    {
      type: 'decision.accepted',
      projectId: input.projectId,
      scopeType: 'project',
      scopeId: decision.id,
      actor,
      payload: accepted,
    },
  ]);
  await rebuildProjectProjection(input.projectId);
  return accepted;
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
