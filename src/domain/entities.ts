export { type ArtifactScope } from './entities/base.js';
export {
  type Project,
  type ProjectStatus,
  createProject,
} from './entities/project.js';
export {
  type Workstream,
  type WorkstreamStatus,
  createWorkstream,
} from './entities/workstream.js';
export {
  type OwnerType,
  type Priority,
  type Task,
  type TaskStatus,
  createTask,
} from './entities/task.js';
export {
  CONFIDENCE_VALUES,
  type Confidence,
  type Handoff,
  createHandoff,
  isConfidence,
} from './entities/handoff.js';
export {
  type Checkpoint,
  createCheckpoint,
} from './entities/checkpoint.js';
export {
  type Decision,
  type DecisionStatus,
  type DecisionSupersededPayload,
  createDecision,
} from './entities/decision.js';
export { type Rule, createRule } from './entities/rule.js';
export {
  type Conflict,
  type ConflictStatus,
  type ConflictType,
  createConflict,
} from './entities/conflict.js';
export {
  type Session,
  type SessionHeartbeatPayload,
  createSession,
} from './entities/session.js';
export {
  type OtherActiveTask,
  type OtherActiveTaskAssignment,
  type StartupContextPayload,
} from './entities/startup-context.js';
export { type MemoryIndex } from './entities/memory-index.js';
export {
  type FileConflictWarning,
  type LiveUpdate,
  type SiblingMemoryItem,
  type SiblingObservationItem,
} from './entities/live-update.js';
export {
  MAX_SALIENCE,
  MIN_SALIENCE,
  type ConsolidatedMemory,
  type ConsolidatedMemoryKind,
  type MemorySupersededPayload,
  type Observation,
  type ObservationSignal,
  clampSalience,
  createConsolidatedMemory,
  createObservation,
} from './entities/memory.js';
export {
  type ProjectSyncState,
  type SyncStatus,
  type SyncTransportConfig,
} from './entities/sync-state.js';
