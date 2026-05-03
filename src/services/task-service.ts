import path from 'node:path';

import { ACTOR_SYSTEM } from '../domain/common.js';
import { appendEvent } from '../storage/event-store.js';
import { readJson, readJsonDir } from '../storage/fs-utils.js';
import {
  getCheckpointFile,
  getHandoffFile,
  getProjectRoot,
  getTaskFile,
} from '../storage/path-resolver.js';
import { rebuildProjectProjection } from './projection-store.js';
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
import type { Checkpoint, Handoff, Task } from '../domain/entities.js';
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

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const markers: InjectionMarker[] = [];
  guardField(input.title, 'task.title', markers);
  guardField(input.description, 'task.description', markers);
  guardField(input.goal, 'task.goal', markers);
  guardStringList(input.acceptanceCriteria, 'task.acceptanceCriteria', markers);
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

  const handoff = createHandoffEntity(input);
  await appendEvent({
    type: 'handoff.created',
    projectId: input.projectId,
    scopeType: 'task',
    scopeId: input.taskId,
    actor: input.fromActor,
    payload: handoff,
  });
  await appendEvent({
    type: 'task.updated',
    projectId: input.projectId,
    scopeType: 'task',
    scopeId: input.taskId,
    actor: input.fromActor,
    payload: {
      latestHandoffId: handoff.id,
      status: 'handoff_ready',
    } satisfies Partial<Task>,
  });
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
  await appendEvent({
    type: 'checkpoint.created',
    projectId: input.projectId,
    scopeType: input.taskId ? 'task' : 'session',
    scopeId: input.taskId ?? input.sessionId,
    actor: ACTOR_SYSTEM,
    payload: checkpoint,
  });
  if (input.taskId) {
    await appendEvent({
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
  await rebuildProjectProjection(input.projectId);
  return checkpoint;
}

export async function readTask(
  projectId: string,
  taskId: string,
): Promise<Task | undefined> {
  return readJson<Task>(getTaskFile(projectId, taskId));
}

export interface ListTasksFilters {
  status?: Task['status'];
  workstreamId?: string;
}

export async function listTasks(
  projectId: string,
  filters: ListTasksFilters = {},
): Promise<Task[]> {
  const tasksDir = path.join(getProjectRoot(projectId), 'tasks');
  const tasks = await readJsonDir<Task>(tasksDir);
  return tasks
    .filter(
      (task) =>
        (!filters.status || task.status === filters.status) &&
        (!filters.workstreamId || task.workstreamId === filters.workstreamId),
    )
    .sort((left, right) => (left.createdAt < right.createdAt ? -1 : 1));
}

export async function readHandoff(
  projectId: string,
  handoffId: string,
): Promise<Handoff | undefined> {
  return readJson<Handoff>(getHandoffFile(projectId, handoffId));
}

export async function readCheckpoint(
  projectId: string,
  checkpointId: string,
): Promise<Checkpoint | undefined> {
  return readJson<Checkpoint>(getCheckpointFile(projectId, checkpointId));
}
