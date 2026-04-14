import type { BaseEntity, EntityId } from './common.js';
import type {
  Checkpoint,
  ChecklistItem,
  Conflict,
  Decision,
  Handoff,
  Project,
  ProjectSyncState,
  Rule,
  Session,
  Task,
  Workstream,
} from './entities.js';

export type DomainEventType =
  | 'project.created'
  | 'project.updated'
  | 'workstream.created'
  | 'workstream.updated'
  | 'task.created'
  | 'task.updated'
  | 'checklist.item.upserted'
  | 'handoff.created'
  | 'checkpoint.created'
  | 'decision.proposed'
  | 'decision.accepted'
  | 'rule.upserted'
  | 'conflict.detected'
  | 'conflict.resolved'
  | 'session.started'
  | 'session.completed'
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
  | ChecklistItem
  | Handoff
  | Checkpoint
  | Decision
  | Rule
  | Conflict
  | Session
  | ProjectSyncState;
