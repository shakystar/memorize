import type { BaseEntity, EntityId } from './common.js';
import type {
  Checkpoint,
  Conflict,
  ConsolidatedMemory,
  Decision,
  DecisionSupersededPayload,
  Handoff,
  MemorySupersededPayload,
  Observation,
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
  | 'decision.superseded'
  | 'rule.upserted'
  | 'conflict.detected'
  | 'conflict.resolved'
  | 'session.started'
  | 'session.resumed'
  | 'session.paused'
  | 'session.completed'
  | 'session.abandoned'
  | 'session.heartbeat'
  | 'sync.state.updated'
  // CLS two-layer memory (Phase 1). Short-term layer = observation.captured
  // (cheap raw episode, no LLM); long-term layer = memory.consolidated
  // (boundary-batch semantic extraction); memory.superseded closes a
  // contradicted memory's validity window WITHOUT deleting anything.
  | 'observation.captured'
  | 'memory.consolidated'
  | 'memory.superseded';

export interface DomainEvent<TPayload = unknown> extends BaseEntity {
  type: DomainEventType;
  projectId: EntityId;
  scopeType: 'policy' | 'project' | 'workstream' | 'task' | 'session';
  scopeId: EntityId;
  actor: string;
  /**
   * Per-event provenance (3.0.0 Phase 0). `writer` = the originating actor
   * identity; `sourceProjectId` = the originating store id. OPTIONAL and
   * currently UNCONSUMED — captured on append and preserved across sync so later
   * phases can group, filter, and recover by origin. Absent on legacy/pre-3.0.0
   * events (column NULL).
   */
  writer?: string;
  sourceProjectId?: EntityId;
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
  | DecisionSupersededPayload
  | Rule
  | Conflict
  | Session
  | SessionHeartbeatPayload
  | ProjectSyncState
  | Observation
  | ConsolidatedMemory
  | MemorySupersededPayload;
