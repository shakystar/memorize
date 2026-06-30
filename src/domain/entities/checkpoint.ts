import type { BaseEntity, EntityId } from '../common.js';
import { baseEntity } from './base.js';

export interface Checkpoint extends BaseEntity {
  projectId: EntityId;
  taskId?: EntityId;
  sessionId: EntityId;
  summary: string;
  taskUpdates: string[];
  projectUpdates: string[];
  promotedDecisions: EntityId[];
  deferredItems: string[];
  discardableItems: string[];
  /** Stable hook logical id for idempotent boundary handling. */
  sourceHookId?: string;
}

export function createCheckpoint(input: {
  projectId: string;
  sessionId: string;
  summary: string;
  taskId?: string;
  taskUpdates?: string[];
  projectUpdates?: string[];
  promotedDecisions?: string[];
  deferredItems?: string[];
  discardableItems?: string[];
  sourceHookId?: string;
}): Checkpoint {
  return {
    ...baseEntity('checkpoint'),
    projectId: input.projectId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    sessionId: input.sessionId,
    summary: input.summary,
    taskUpdates: input.taskUpdates ?? [],
    projectUpdates: input.projectUpdates ?? [],
    promotedDecisions: input.promotedDecisions ?? [],
    deferredItems: input.deferredItems ?? [],
    discardableItems: input.discardableItems ?? [],
    ...(input.sourceHookId ? { sourceHookId: input.sourceHookId } : {}),
  };
}
