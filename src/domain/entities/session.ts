import type { BaseEntity, EntityId, ISODateString } from '../common.js';
import { baseEntity } from './base.js';
import { nowIso } from '../common.js';

export interface Session extends BaseEntity {
  projectId: EntityId;
  taskId?: EntityId;
  actor: string;
  startedAt: ISODateString;
  endedAt?: ISODateString;
  status: 'active' | 'completed';
}

export function createSession(input: {
  projectId: string;
  actor: string;
  taskId?: string;
}): Session {
  const timestamp = nowIso();
  return {
    ...baseEntity('session'),
    projectId: input.projectId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    actor: input.actor,
    startedAt: timestamp,
    status: 'active',
  };
}
