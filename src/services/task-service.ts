import { ACTOR_SYSTEM } from '../domain/common.js';
import { appendEvent, appendEvents } from '../storage/event-store.js';
import {
  getCheckpoint,
  getHandoff,
  getTask,
  listTasks as listTasksFromStore,
  rebuildProjectProjection,
  type ListTasksFilters,
} from './projection-store.js';
import type {
  CreateCheckpointInput,
  CreateHandoffInput,
  CreateTaskInput,
} from '../domain/commands.js';
import {
  createCheckpoint as createCheckpointEntity,
  createHandoff as createHandoffEntity,
  createTask as createTaskEntity,
} from '../domain/entities.js';
import type {
  Checkpoint,
  Handoff,
  Task,
  TaskAppendableField,
  TaskItemAppendedPayload,
} from '../domain/entities.js';
import { assertTaskStatusTransition } from '../domain/state-machines.js';
import {
  assertArrayLength,
  assertContentLength,
  detectInjectionMarkers,
  warnInjectionMarkers,
  type InjectionMarker,
} from '../shared/content-safety.js';
import { MemorizeError } from '../shared/errors.js';

function guardField(
  value: string | undefined,
  field: string,
  collected: InjectionMarker[],
): void {
  if (value === undefined) return;
  assertContentLength(value, field);
  collected.push(...detectInjectionMarkers(value, field));
}

function guardStringList(
  values: string[] | undefined,
  field: string,
  collected: InjectionMarker[],
): void {
  if (!values) return;
  assertArrayLength(values, field);
  values.forEach((value, index) =>
    guardField(value, `${field}[${index}]`, collected),
  );
}

// A blank list item is "filled-looking empty" data — the same pathology as
// the old title-copied description/goal defaults. Reject loudly instead of
// letting `--question ""` append an empty row the Hub would render.
function assertNoBlankItems(
  values: string[] | undefined,
  field: string,
): void {
  if (!values) return;
  if (values.some((value) => value.trim() === '')) {
    throw new MemorizeError(`${field} items must be non-empty.`);
  }
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const markers: InjectionMarker[] = [];
  guardField(input.title, 'task.title', markers);
  guardField(input.description, 'task.description', markers);
  guardField(input.goal, 'task.goal', markers);
  guardStringList(input.acceptanceCriteria, 'task.acceptanceCriteria', markers);
  assertNoBlankItems(input.acceptanceCriteria, 'task.acceptanceCriteria');
  warnInjectionMarkers(markers);

  const task = createTaskEntity(input);
  await appendEvent({
    type: 'task.created',
    projectId: input.projectId,
    scopeType: 'task',
    scopeId: task.id,
    actor: input.actor ?? ACTOR_SYSTEM,
    payload: task,
  });
  await rebuildProjectProjection(input.projectId);
  return task;
}

export async function updateTask(
  projectId: string,
  taskId: string,
  patch: Partial<Task>,
  actor = 'system',
): Promise<void> {
  if (patch.status !== undefined) {
    const existing = await readTask(projectId, taskId);
    if (!existing) {
      throw new MemorizeError(`Task ${taskId} not found in project ${projectId}`);
    }
    if (existing.status !== patch.status) {
      assertTaskStatusTransition(existing.status, patch.status);
    }
  }
  await appendEvent({
    type: 'task.updated',
    projectId,
    scopeType: 'task',
    scopeId: taskId,
    actor,
    payload: patch,
  });
  await rebuildProjectProjection(projectId);
}

export interface AppendTaskItemsInput {
  projectId: string;
  taskId: string;
  items: Partial<Record<TaskAppendableField, string[]>>;
  actor?: string;
}

/**
 * Append items to a task's list fields (acceptanceCriteria / openQuestions /
 * riskNotes) as one `task.item-appended` event PER ITEM, batched atomically.
 * Item-level events keep the log a G-Set (SoT-030): two sessions appending
 * concurrently union cleanly instead of clobbering each other's arrays.
 */
export async function appendTaskItems(
  input: AppendTaskItemsInput,
): Promise<void> {
  const markers: InjectionMarker[] = [];
  for (const [field, values] of Object.entries(input.items)) {
    guardStringList(values, `task.${field}`, markers);
    assertNoBlankItems(values, `task.${field}`);
  }
  warnInjectionMarkers(markers);

  const existing = await getTask(input.projectId, input.taskId);
  if (!existing) {
    throw new MemorizeError(
      `Task ${input.taskId} not found in project ${input.projectId}`,
    );
  }
  const events: Parameters<typeof appendEvents>[1] = [];
  for (const [field, values] of Object.entries(input.items)) {
    for (const text of values ?? []) {
      events.push({
        type: 'task.item-appended',
        projectId: input.projectId,
        scopeType: 'task',
        scopeId: input.taskId,
        actor: input.actor ?? ACTOR_SYSTEM,
        payload: {
          field: field as TaskAppendableField,
          text,
        } satisfies TaskItemAppendedPayload,
      });
    }
  }
  if (events.length === 0) {
    throw new MemorizeError('appendTaskItems requires at least one item.');
  }
  await appendEvents(input.projectId, events);
  await rebuildProjectProjection(input.projectId);
}

export async function createHandoff(input: CreateHandoffInput): Promise<Handoff> {
  const markers: InjectionMarker[] = [];
  guardField(input.summary, 'handoff.summary', markers);
  guardField(input.nextAction, 'handoff.nextAction', markers);
  guardStringList(input.doneItems, 'handoff.doneItems', markers);
  guardStringList(input.remainingItems, 'handoff.remainingItems', markers);
  guardStringList(input.warnings, 'handoff.warnings', markers);
  guardStringList(
    input.unresolvedQuestions,
    'handoff.unresolvedQuestions',
    markers,
  );
  warnInjectionMarkers(markers);

  const existing = await getTask(input.projectId, input.taskId);
  if (!existing) {
    throw new MemorizeError(
      `Task ${input.taskId} not found in project ${input.projectId}`,
    );
  }
  // Route the status change through the state machine instead of the old
  // direct-append bypass: a handoff from `todo` is rejected (start first),
  // while a re-handoff (already handoff_ready) is allowed and simply
  // refreshes the snapshot pointer.
  if (existing.status !== 'handoff_ready') {
    assertTaskStatusTransition(existing.status, 'handoff_ready');
  }

  const handoff = createHandoffEntity(input);
  const events: Parameters<typeof appendEvents>[1] = [
    {
      type: 'handoff.created',
      projectId: input.projectId,
      scopeType: 'task',
      scopeId: input.taskId,
      actor: input.fromActor,
      payload: handoff,
    },
    {
      type: 'task.updated',
      projectId: input.projectId,
      scopeType: 'task',
      scopeId: input.taskId,
      actor: input.fromActor,
      payload: {
        latestHandoffId: handoff.id,
        status: 'handoff_ready',
      } satisfies Partial<Task>,
    },
  ];
  await appendEvents(input.projectId, events);
  await rebuildProjectProjection(input.projectId);
  return handoff;
}

export async function createCheckpoint(
  input: CreateCheckpointInput,
): Promise<Checkpoint> {
  const markers: InjectionMarker[] = [];
  guardField(input.summary, 'checkpoint.summary', markers);
  guardStringList(input.taskUpdates, 'checkpoint.taskUpdates', markers);
  guardStringList(input.projectUpdates, 'checkpoint.projectUpdates', markers);
  guardStringList(input.deferredItems, 'checkpoint.deferredItems', markers);
  guardStringList(
    input.discardableItems,
    'checkpoint.discardableItems',
    markers,
  );
  warnInjectionMarkers(markers);

  const checkpoint = createCheckpointEntity(input);
  const events: Parameters<typeof appendEvents>[1] = [
    {
      type: 'checkpoint.created',
      projectId: input.projectId,
      scopeType: input.taskId ? 'task' : 'session',
      scopeId: input.taskId ?? input.sessionId,
      actor: ACTOR_SYSTEM,
      payload: checkpoint,
    },
  ];
  if (input.taskId) {
    events.push({
      type: 'task.updated',
      projectId: input.projectId,
      scopeType: 'task',
      scopeId: input.taskId,
      actor: ACTOR_SYSTEM,
      payload: {
        latestCheckpointId: checkpoint.id,
      } satisfies Partial<Task>,
    });
  }
  await appendEvents(input.projectId, events);
  await rebuildProjectProjection(input.projectId);
  return checkpoint;
}

export async function readTask(
  projectId: string,
  taskId: string,
): Promise<Task | undefined> {
  return getTask(projectId, taskId);
}

export type { ListTasksFilters } from './projection-store.js';

export async function listTasks(
  projectId: string,
  filters: ListTasksFilters = {},
): Promise<Task[]> {
  return listTasksFromStore(projectId, filters);
}

export async function readHandoff(
  projectId: string,
  handoffId: string,
): Promise<Handoff | undefined> {
  return getHandoff(projectId, handoffId);
}

export async function readCheckpoint(
  projectId: string,
  checkpointId: string,
): Promise<Checkpoint | undefined> {
  return getCheckpoint(projectId, checkpointId);
}
