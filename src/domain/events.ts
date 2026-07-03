import type { BaseEntity, EntityId } from './common.js';
import type {
  Checkpoint,
  Conflict,
  ConsolidatedMemory,
  Decision,
  DecisionSupersededPayload,
  Handoff,
  MemoryRetractedPayload,
  MemorySupersededPayload,
  Observation,
  Project,
  ProjectSyncState,
  Rule,
  Session,
  SessionHeartbeatPayload,
  Task,
  TaskItemAppendedPayload,
  TaskRequest,
  TaskRequestAcceptedPayload,
  TaskRequestDeclinedPayload,
  Workstream,
} from './entities.js';

export type DomainEventType =
  | 'project.created'
  | 'project.updated'
  | 'workstream.created'
  | 'task.created'
  | 'task.updated'
  // Item-level append into a Task list field (acceptanceCriteria /
  // openQuestions / riskNotes). One event per item keeps the log a G-Set
  // (SoT-030): concurrent writers union cleanly, where a whole-array
  // `task.updated` patch would last-writer-wins away the other's items.
  | 'task.item-appended'
  // Cross-project delegation (SoT-041). `task.requested` is authored in the
  // REQUESTER's store and addresses a member project via payload
  // targetProjectId; accept/decline are authored by the TARGET's local writer
  // and reference the request by id. Propose-accept keeps task minting local:
  // a request never becomes a task without a local `task.created`.
  | 'task.requested'
  | 'task.request-accepted'
  | 'task.request-declined'
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
  | 'memory.superseded'
  // Tombstone (3.0.0 M3, SoT-050): retract a memory with no replacement. Like
  // memory.superseded it closes the validity window instead of deleting the
  // row, but carries no replacement and is reversible + audit-preserving.
  | 'memory.retracted';

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
  | TaskItemAppendedPayload
  | TaskRequest
  | TaskRequestAcceptedPayload
  | TaskRequestDeclinedPayload
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
  | MemorySupersededPayload
  | MemoryRetractedPayload;
