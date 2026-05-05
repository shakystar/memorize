import type { BaseEntity, EntityId } from './common.js';
import type {
  Checkpoint,
  Conflict,
  Decision,
  Handoff,
  Project,
  ProjectSyncState,
  Rule,
  Session,
  SessionHeartbeatPayload,
  Task,
  Workstream,
} from './entities.js';

export type DomainEventType =
  | 'project.created'
  | 'project.updated'
  | 'workstream.created'
  | 'task.created'
  | 'task.updated'
  | 'handoff.created'
  | 'checkpoint.created'
  | 'decision.proposed'
  | 'decision.accepted'
  | 'rule.upserted'
  | 'conflict.detected'
  | 'conflict.resolved'
  | 'session.started'
  | 'session.resumed'
  | 'session.completed'
  | 'session.abandoned'
  | 'session.heartbeat'
  | 'sync.state.updated';

export interface DomainEvent<TPayload = unknown> extends BaseEntity {
  type: DomainEventType;
  projectId: EntityId;
  scopeType: 'policy' | 'project' | 'workstream' | 'task' | 'session';
  scopeId: EntityId;
  actor: string;
  payload: TPayload;
}

export type DomainEventPayload =
  | Project
  | Partial<Project>
  | Workstream
  | Partial<Workstream>
  | Task
  | Partial<Task>
  | Handoff
  | Checkpoint
  | Decision
  | Rule
  | Conflict
  | Session
  | SessionHeartbeatPayload
  | ProjectSyncState;
