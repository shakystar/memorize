import fs from 'node:fs/promises';

import path from 'node:path';

import {
  appendEvent,
  appendEvents,
  ensureProjectDirectories,
} from '../storage/event-store.js';
import {
  bindProject,
  readBindings,
  resolveBindingForPath,
  resolveProjectIdForPath,
  unbindPath,
} from '../storage/bindings-store.js';
import type { BindingMatch } from '../storage/bindings-store.js';
import { isEnoent, readJson, writeJson } from '../storage/fs-utils.js';
import {
  getDecision,
  getMemory,
  getProjectProjection,
  getWorkstream,
  listDecisions,
  listValidMemories,
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
  DecisionSupersededPayload,
  MemoryRetractedPayload,
  Project,
  ProjectSyncState,
  Workstream,
} from '../domain/entities.js';
import type { DomainEventPayload } from '../domain/events.js';
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

/**
 * Correct/replace a recorded decision by superseding it — append-only,
 * mirroring `memory.superseded`. We record the replacement as a brand-new
 * decision (`decision.proposed` + `decision.accepted`) and append a
 * `decision.superseded` marker that closes out the old one; the original
 * decision row is preserved (the projector flips its status to `superseded`
 * and stamps `supersededBy`), so point-in-time replays still see what was
 * decided then and `acceptedDecisionIds` automatically drops it.
 */
export async function supersedeDecision(input: {
  projectId: string;
  supersedesId: string;
  title: string;
  decision: string;
  rationale?: string;
  reason?: string;
  actor?: string;
}): Promise<{ decision: Decision; supersededId: string }> {
  const actor = input.actor ?? ACTOR_SYSTEM;
  const existing = getDecision(input.projectId, input.supersedesId);
  if (!existing) {
    throw new Error(
      `Decision ${input.supersedesId} not found in project ${input.projectId}.`,
    );
  }
  if (existing.status === 'superseded') {
    throw new Error(
      `Decision ${input.supersedesId} is already superseded (by ${existing.supersededBy ?? 'unknown'}).`,
    );
  }

  const replacement = createDecisionEntity({
    scopeType: 'project',
    scopeId: input.projectId,
    title: input.title,
    decision: input.decision,
    rationale: input.rationale ?? '',
    createdBy: actor,
  });
  const accepted: Decision = { ...replacement, status: 'accepted' };

  const supersededPayload: DecisionSupersededPayload = {
    supersedes: input.supersedesId,
    supersededBy: replacement.id,
    ...(input.reason ? { reason: input.reason } : {}),
  };
  await appendEvents<DomainEventPayload>(input.projectId, [
    {
      type: 'decision.proposed',
      projectId: input.projectId,
      scopeType: 'project',
      scopeId: replacement.id,
      actor,
      payload: replacement,
    },
    {
      type: 'decision.accepted',
      projectId: input.projectId,
      scopeType: 'project',
      scopeId: replacement.id,
      actor,
      payload: accepted,
    },
    {
      type: 'decision.superseded',
      projectId: input.projectId,
      scopeType: 'project',
      scopeId: input.supersedesId,
      actor,
      payload: supersededPayload,
    },
  ]);
  await rebuildProjectProjection(input.projectId);
  return { decision: accepted, supersededId: input.supersedesId };
}

/**
 * Retract a consolidated memory (M3, SoT-050). Appends a `memory.retracted`
 * tombstone — it never deletes the memory row or the events it was distilled
 * from. The projection rebuild closes the memory's validity window
 * (`invalidAt`) and drops it from search, so it stops surfacing in
 * list/search/injection, while the original row + event survive for audit and
 * reversibility. Idempotent: retracting an already-invalid memory (superseded
 * or already-retracted) still records the tombstone (`alreadyInvalid=true`)
 * without changing the effective validity window. The consolidation dedup
 * guard keys on ALL memory rows including retracted ones, so the retracted
 * memory keeps shielding its source observations — a retract is not re-derived
 * on the next boundary.
 */
export async function retractMemory(input: {
  projectId: string;
  memoryId: string;
  reason?: string;
  actor?: string;
}): Promise<{ memoryId: string; alreadyInvalid: boolean }> {
  const actor = input.actor ?? ACTOR_SYSTEM;
  const row = getMemory(input.projectId, input.memoryId);
  if (!row) {
    throw new Error(
      `Memory ${input.memoryId} not found in project ${input.projectId}.`,
    );
  }
  const alreadyInvalid = Boolean(row.memory.invalidAt);

  const payload: MemoryRetractedPayload = {
    retracts: input.memoryId,
    ...(input.reason ? { reason: input.reason } : {}),
  };
  // Scoped like memory.consolidated/superseded (scopeType 'session', scopeId
  // falling back to the project when there is no live session); the memory
  // reducer keys off payload.retracts, so scope is provenance only. The event's
  // `writer`/`sourceProjectId` default to the local actor/store in appendEvent,
  // which is what a future owner-only global retract reads to judge role.
  await appendEvent<DomainEventPayload>({
    type: 'memory.retracted',
    projectId: input.projectId,
    scopeType: 'session',
    scopeId: input.projectId,
    actor,
    payload,
  });
  await rebuildProjectProjection(input.projectId);
  return { memoryId: input.memoryId, alreadyInvalid };
}

/**
 * Revert the consolidated memories a single session produced (M3-c, SoT-050).
 * Contamination revert is "rewind + re-derive from a clean event set": this
 * batch-retracts every still-valid, self-lane memory tagged with `sessionId`
 * (reusing the M3-a `memory.retracted` tombstone) and rebuilds, so the
 * projection re-derives WITHOUT those memories. Deterministic (pure projection
 * replay over the now-clean set), append-only, and reversible — nothing is
 * deleted, and the retracted rows keep shielding their source observations so a
 * later consolidation boundary does not revive them.
 *
 * Self-lane only: a foreign-lane (workspace-union) memory belongs to another
 * writer, and reverting someone else's contribution is the owner-only GLOBAL
 * retract (SoT-040), deferred to W3. `dryRun` lists what would be reverted
 * without appending anything. A session with no still-valid memories is a no-op
 * (`reverted: []`).
 */
export async function revertSession(input: {
  projectId: string;
  sessionId: string;
  reason?: string;
  dryRun?: boolean;
  actor?: string;
}): Promise<{ sessionId: string; reverted: string[]; dryRun: boolean }> {
  const actor = input.actor ?? ACTOR_SYSTEM;
  const dryRun = input.dryRun ?? false;
  const targets = listValidMemories(input.projectId)
    .map((row) => row.memory)
    .filter((memory) => memory.sessionId === input.sessionId);
  const reverted = targets.map((memory) => memory.id);

  if (dryRun || reverted.length === 0) {
    return { sessionId: input.sessionId, reverted, dryRun };
  }

  const reason = input.reason ?? `session ${input.sessionId} reverted`;
  await appendEvents<DomainEventPayload>(
    input.projectId,
    targets.map((memory) => ({
      type: 'memory.retracted',
      projectId: input.projectId,
      scopeType: 'session',
      scopeId: input.projectId,
      actor,
      payload: { retracts: memory.id, reason } as MemoryRetractedPayload,
    })),
  );
  await rebuildProjectProjection(input.projectId);
  return { sessionId: input.sessionId, reverted, dryRun: false };
}

export async function getBoundProjectId(
  rootPath: string,
): Promise<string | undefined> {
  return resolveProjectIdForPath(rootPath);
}

/**
 * Resolve the binding for a path WITH its kind (exact vs ancestor). Used by
 * binding-creation commands (`project setup`/`init`) that must not absorb a
 * subdirectory into its parent (#151). `getBoundProjectId` (walk-up) remains the
 * operational resolver — `ensureBoundProjectId`/`requireBoundProjectId` keep it.
 */
export async function getBindingForPath(
  rootPath: string,
): Promise<BindingMatch | undefined> {
  return resolveBindingForPath(rootPath);
}

export async function ensureBoundProjectId(cwd: string): Promise<string> {
  const existing = await getBoundProjectId(cwd);
  if (existing) return existing;
  const { setupProject } = await import('./setup-service.js');
  const setup = await setupProject(cwd);
  // Hooks run setup non-interactively; surface a moved-repo warning to stderr so
  // it is never silently swallowed, but never block (#145).
  for (const warning of setup.warnings) {
    process.stderr.write(`memorize: ${warning}\n`);
  }
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

export function readDecision(
  projectId: string,
  decisionId: string,
): Decision | undefined {
  return getDecision(projectId, decisionId);
}

export function readDecisions(
  projectId: string,
  opts: { includeSuperseded?: boolean } = {},
): Decision[] {
  return listDecisions(projectId, opts);
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
