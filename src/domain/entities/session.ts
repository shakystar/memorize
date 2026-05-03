import type { BaseEntity, EntityId, ISODateString } from '../common.js';
import { baseEntity } from './base.js';
import { nowIso } from '../common.js';

export interface Session extends BaseEntity {
  projectId: EntityId;
  taskId?: EntityId;
  actor: string;
  startedAt: ISODateString;
  endedAt?: ISODateString;
  /** Most recent activity attributed to this session — bumped on heartbeat events. */
  lastSeenAt: ISODateString;
  /** `active` while running, `completed` on a clean end (Claude SessionEnd
   *  hook, explicit CLI), `abandoned` when reaped without a clean end
   *  (heartbeat timeout, next SessionStart in the same cwd, or explicit
   *  `memorize session reap`). */
  status: 'active' | 'completed' | 'abandoned';
}

export interface SessionHeartbeatPayload {
  sessionId: EntityId;
  at: ISODateString;
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
    lastSeenAt: timestamp,
    status: 'active',
  };
}
