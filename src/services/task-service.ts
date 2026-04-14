import { appendEvent } from '../storage/event-store.js';
import { readJson } from '../storage/fs-utils.js';
import {
  getCheckpointFile,
  getHandoffFile,
  getTaskFile,
} from '../storage/path-resolver.js';
import { rebuildProjectProjection } from '../storage/projection-store.js';
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

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const task = createTaskEntity(input);
  await appendEvent({
    type: 'task.created',
    projectId: input.projectId,
    scopeType: 'task',
    scopeId: task.id,
    actor: input.actor ?? 'system',
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
  const checkpoint = createCheckpointEntity(input);
  await appendEvent({
    type: 'checkpoint.created',
    projectId: input.projectId,
    scopeType: input.taskId ? 'task' : 'session',
    scopeId: input.taskId ?? input.sessionId,
    actor: 'system',
    payload: checkpoint,
  });
  if (input.taskId) {
    await appendEvent({
      type: 'task.updated',
      projectId: input.projectId,
      scopeType: 'task',
      scopeId: input.taskId,
      actor: 'system',
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
