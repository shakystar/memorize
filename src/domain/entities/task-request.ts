import type { BaseEntity, EntityId } from '../common.js';
import { baseEntity } from './base.js';

export type TaskRequestStatus = 'pending' | 'accepted' | 'declined';

/**
 * Cross-project delegation request (SoT-041). Lives in the REQUESTER's lane;
 * `targetProjectId` addresses a workspace member project (never a writer).
 * The entity itself is immutable in the log — `status`/`resolvedByTaskId`/
 * `declineReason` are folded in by the projector from later
 * `task.request-accepted` / `task.request-declined` events, which may come
 * from any lane.
 */
export interface TaskRequest extends BaseEntity {
  projectId: EntityId;
  targetProjectId: EntityId;
  title: string;
  description: string;
  goal: string;
  acceptanceCriteria: string[];
  status: TaskRequestStatus;
  resolvedByTaskId?: EntityId;
  declineReason?: string;
}

export interface TaskRequestAcceptedPayload {
  requestId: EntityId;
  taskId: EntityId;
}

export interface TaskRequestDeclinedPayload {
  requestId: EntityId;
  reason: string;
}

export function createTaskRequest(input: {
  projectId: string;
  targetProjectId: string;
  title: string;
  description?: string;
  goal?: string;
  acceptanceCriteria?: string[];
}): TaskRequest {
  return {
    ...baseEntity('taskreq'),
    projectId: input.projectId,
    targetProjectId: input.targetProjectId,
    title: input.title,
    // No title fallback: an absent description/goal stays empty rather than
    // masquerading as filled — consumers treat '' as absent (same as Task).
    description: input.description ?? '',
    goal: input.goal ?? '',
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    status: 'pending',
  };
}
