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
  /** `active` while the host agent is running. `paused` when the agent
   *  CLI has exited cleanly (Claude SessionEnd, eventual codex
   *  equivalent) but the session is intentionally kept resumable —
   *  `claude --resume` / `codex resume` will reattach via
   *  agentSessionId match and the projector flips it back to `active`.
   *  `completed` is reserved for explicit user termination via the
   *  CLI. `abandoned` is what the reap sweep writes when an `active`
   *  or `paused` session goes past its heartbeat staleness threshold
   *  without a resume. */
  status: 'active' | 'paused' | 'completed' | 'abandoned';
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
