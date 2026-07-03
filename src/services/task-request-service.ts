import { ACTOR_SYSTEM } from '../domain/common.js';
import { createTaskRequest as createTaskRequestEntity } from '../domain/entities.js';
import type {
  Task,
  TaskRequest,
  TaskRequestAcceptedPayload,
  TaskRequestDeclinedPayload,
} from '../domain/entities.js';
import {
  reduceProjectState,
  type MemberProject,
} from '../projections/projector.js';
import {
  assertArrayLength,
  assertContentLength,
  detectInjectionMarkers,
  warnInjectionMarkers,
  type InjectionMarker,
} from '../shared/content-safety.js';
import { MemorizeError } from '../shared/errors.js';
import { appendEvent, readEvents } from '../storage/event-store.js';
import {
  getTaskRequest,
  rebuildProjectProjection,
} from './projection-store.js';
import { createTask } from './task-service.js';

export type { MemberProject } from '../projections/projector.js';
export {
  getTaskRequest,
  listTaskRequests,
  type ListTaskRequestsFilters,
} from './projection-store.js';

function guardField(
  value: string | undefined,
  field: string,
  collected: InjectionMarker[],
): void {
  if (value === undefined) return;
  assertContentLength(value, field);
  collected.push(...detectInjectionMarkers(value, field));
}

// A blank list item is "filled-looking empty" data — the same pathology
// task-service rejects. It must be rejected HERE, before the event is
// appended: acceptTaskRequest feeds these criteria into createTask, whose
// own blank-item guard throws, so a persisted request carrying a blank item
// would be durably stuck — pending forever, every accept failing.
function assertNoBlankItems(
  values: string[] | undefined,
  field: string,
): void {
  if (!values) return;
  if (values.some((value) => value.trim() === '')) {
    throw new MemorizeError(`${field} items must be non-empty.`);
  }
}

/**
 * The addressable roster (SoT-041): every genesis in the local union — self
 * plus each workspace member whose whole-DB push has landed. Derived from the
 * event log on demand; no Hub round-trip and no new control-plane surface.
 */
export async function listMemberProjects(
  projectId: string,
): Promise<MemberProject[]> {
  const state = reduceProjectState(await readEvents(projectId), projectId);
  return Object.values(state.memberProjects);
}

/**
 * Resolve a `--to` reference — a `proj_…` id or a project title — against the
 * roster. Exact id wins; otherwise a unique case-insensitive title. Fails
 * loud on no/ambiguous match (never guess a delegation target).
 */
export function resolveTargetProject(
  members: MemberProject[],
  ref: string,
): MemberProject {
  const byId = members.find((m) => m.id === ref);
  if (byId) return byId;
  const needle = ref.toLowerCase();
  const byTitle = members.filter((m) => m.title.toLowerCase() === needle);
  if (byTitle.length === 1) return byTitle[0]!;
  if (byTitle.length > 1) {
    throw new MemorizeError(
      `"${ref}" matches ${byTitle.length} member projects; use the proj_ id.`,
    );
  }
  throw new MemorizeError(
    `No workspace member project matches "${ref}". ` +
      'Run `memorize workspace sources` to list addressable projects.',
  );
}

export interface RequestTaskInput {
  projectId: string;
  targetRef: string;
  title: string;
  description?: string;
  goal?: string;
  acceptanceCriteria?: string[];
  actor?: string;
}

export async function requestTask(
  input: RequestTaskInput,
): Promise<TaskRequest> {
  const markers: InjectionMarker[] = [];
  guardField(input.title, 'taskRequest.title', markers);
  guardField(input.description, 'taskRequest.description', markers);
  guardField(input.goal, 'taskRequest.goal', markers);
  if (input.acceptanceCriteria) {
    assertArrayLength(input.acceptanceCriteria, 'taskRequest.acceptanceCriteria');
    input.acceptanceCriteria.forEach((value, index) =>
      guardField(value, `taskRequest.acceptanceCriteria[${index}]`, markers),
    );
    assertNoBlankItems(input.acceptanceCriteria, 'taskRequest.acceptanceCriteria');
  }
  warnInjectionMarkers(markers);

  const members = await listMemberProjects(input.projectId);
  const target = resolveTargetProject(members, input.targetRef);
  if (target.isSelf) {
    throw new MemorizeError(
      'A task request cannot address this project itself — ' +
        'use `memorize task create` for local work.',
    );
  }

  const request = createTaskRequestEntity({
    projectId: input.projectId,
    targetProjectId: target.id,
    title: input.title,
    ...(input.description ? { description: input.description } : {}),
    ...(input.goal ? { goal: input.goal } : {}),
    ...(input.acceptanceCriteria
      ? { acceptanceCriteria: input.acceptanceCriteria }
      : {}),
  });
  await appendEvent({
    type: 'task.requested',
    projectId: input.projectId,
    scopeType: 'project',
    scopeId: request.id,
    actor: input.actor ?? ACTOR_SYSTEM,
    payload: request,
  });
  await rebuildProjectProjection(input.projectId);
  return request;
}

/** Shared accept/decline precondition: the request exists, is pending, and is
 *  addressed to THIS project (SoT-041: only the target's local writer resolves
 *  a request). */
async function requirePendingInbound(
  projectId: string,
  requestId: string,
): Promise<TaskRequest> {
  const request = await getTaskRequest(projectId, requestId);
  if (!request) {
    throw new MemorizeError(`Task request ${requestId} not found.`);
  }
  if (request.targetProjectId !== projectId) {
    throw new MemorizeError(
      `Task request ${requestId} is addressed to ${request.targetProjectId}, not this project.`,
    );
  }
  if (request.status !== 'pending') {
    throw new MemorizeError(
      `Task request ${requestId} is ${request.status}; only a pending request can be resolved.`,
    );
  }
  return request;
}

export async function acceptTaskRequest(input: {
  projectId: string;
  requestId: string;
  actor?: string;
}): Promise<{ request: TaskRequest; task: Task }> {
  const request = await requirePendingInbound(input.projectId, input.requestId);
  // Local mint (SoT-041): the accepted task is an ordinary SELF-lane task —
  // owned, claimed, and completed via the existing task machinery.
  const task = await createTask({
    projectId: input.projectId,
    title: request.title,
    ...(request.description ? { description: request.description } : {}),
    ...(request.goal ? { goal: request.goal } : {}),
    ...(request.acceptanceCriteria.length > 0
      ? { acceptanceCriteria: request.acceptanceCriteria }
      : {}),
    ...(input.actor ? { actor: input.actor } : {}),
  });
  await appendEvent({
    type: 'task.request-accepted',
    projectId: input.projectId,
    scopeType: 'project',
    scopeId: request.id,
    actor: input.actor ?? ACTOR_SYSTEM,
    payload: {
      requestId: request.id,
      taskId: task.id,
    } satisfies TaskRequestAcceptedPayload,
  });
  await rebuildProjectProjection(input.projectId);
  const updated = await getTaskRequest(input.projectId, request.id);
  return { request: updated ?? request, task };
}

export async function declineTaskRequest(input: {
  projectId: string;
  requestId: string;
  reason: string;
  actor?: string;
}): Promise<TaskRequest> {
  if (!input.reason.trim()) {
    throw new MemorizeError('A decline reason is required — it flows back to the requester.');
  }
  const markers: InjectionMarker[] = [];
  guardField(input.reason, 'taskRequest.declineReason', markers);
  warnInjectionMarkers(markers);
  const request = await requirePendingInbound(input.projectId, input.requestId);
  await appendEvent({
    type: 'task.request-declined',
    projectId: input.projectId,
    scopeType: 'project',
    scopeId: request.id,
    actor: input.actor ?? ACTOR_SYSTEM,
    payload: {
      requestId: request.id,
      reason: input.reason,
    } satisfies TaskRequestDeclinedPayload,
  });
  await rebuildProjectProjection(input.projectId);
  const updated = await getTaskRequest(input.projectId, request.id);
  return updated ?? request;
}
