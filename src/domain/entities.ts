import {
  createId,
  CURRENT_SCHEMA_VERSION,
  nowIso,
  type BaseEntity,
  type EntityId,
  type ISODateString,
} from './common.js';

export type ArtifactScope =
  | 'policy'
  | 'project'
  | 'workstream'
  | 'task'
  | 'session';

export type ProjectStatus = 'active' | 'paused' | 'archived';
export type WorkstreamStatus = 'active' | 'paused' | 'closed';
export type TaskStatus =
  | 'todo'
  | 'in_progress'
  | 'blocked'
  | 'handoff_ready'
  | 'done';
export type Priority = 'low' | 'medium' | 'high';
export type OwnerType = 'human' | 'agent' | 'unassigned';
export type ChecklistStatus = 'todo' | 'doing' | 'done' | 'skipped';
export type Confidence = 'low' | 'medium' | 'high';
export type DecisionStatus =
  | 'proposed'
  | 'accepted'
  | 'superseded'
  | 'rejected';
export type ConflictType = 'state' | 'decision' | 'rule' | 'ownership';
export type ConflictStatus =
  | 'detected'
  | 'auto_resolved'
  | 'escalated'
  | 'resolved';
export type SyncStatus = 'idle' | 'syncing' | 'conflicted' | 'offline';

export interface Project extends BaseEntity {
  title: string;
  summary: string;
  goals: string[];
  status: ProjectStatus;
  rootPath: string;
  importedContextCount: number;
  activeWorkstreamIds: EntityId[];
  activeTaskIds: EntityId[];
  acceptedDecisionIds: EntityId[];
  ruleIds: EntityId[];
}

export interface Workstream extends BaseEntity {
  projectId: EntityId;
  title: string;
  summary: string;
  status: WorkstreamStatus;
  locator?: string;
}

export interface Task extends BaseEntity {
  projectId: EntityId;
  workstreamId?: EntityId;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  ownerType: OwnerType;
  ownerId?: string;
  goal: string;
  acceptanceCriteria: string[];
  dependsOn: EntityId[];
  contextRefIds: EntityId[];
  decisionRefIds: EntityId[];
  ruleRefIds: EntityId[];
  openQuestions: string[];
  riskNotes: string[];
  latestHandoffId?: EntityId;
  latestCheckpointId?: EntityId;
}

export interface ChecklistItem extends BaseEntity {
  taskId: EntityId;
  text: string;
  status: ChecklistStatus;
  ownerId?: string;
}

export interface Handoff extends BaseEntity {
  projectId: EntityId;
  taskId: EntityId;
  fromActor: string;
  toActor: string;
  summary: string;
  nextAction: string;
  doneItems: string[];
  remainingItems: string[];
  requiredContextRefs: EntityId[];
  warnings: string[];
  unresolvedQuestions: string[];
  confidence: Confidence;
}

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
}

export interface Decision extends BaseEntity {
  scopeType: Exclude<ArtifactScope, 'session' | 'policy'>;
  scopeId: EntityId;
  title: string;
  decision: string;
  rationale: string;
  status: DecisionStatus;
  relatedRuleIds: EntityId[];
  createdBy: string;
}

export interface Rule extends BaseEntity {
  scopeType: ArtifactScope;
  scopeId: EntityId;
  title: string;
  body: string;
  priority: number;
  source: 'user' | 'team' | 'imported' | 'inferred';
  updatedBy: string;
}

export interface Conflict extends BaseEntity {
  projectId: EntityId;
  scopeType: 'workstream' | 'task' | 'decision' | 'rule';
  scopeId: EntityId;
  fieldPath: string;
  leftVersion: string;
  rightVersion: string;
  conflictType: ConflictType;
  status: ConflictStatus;
  resolutionSummary?: string;
  resolvedBy?: string;
  resolvedAt?: ISODateString;
}

export interface Session extends BaseEntity {
  projectId: EntityId;
  taskId?: EntityId;
  actor: string;
  startedAt: ISODateString;
  endedAt?: ISODateString;
  status: 'active' | 'completed';
}

export interface StartupContextPayload {
  projectSummary: string;
  projectRules: string[];
  workstreamSummary?: string;
  task?: Task;
  latestHandoff?: Handoff;
  openConflicts: Conflict[];
  mustReadTopics: Array<{ id: string; title: string; path: string }>;
}

export interface MemoryIndex {
  schemaVersion: string;
  projectId: EntityId;
  shortSummary: string;
  activeWorkstreams: Array<
    Pick<Workstream, 'id' | 'title' | 'summary' | 'status'>
  >;
  topTasks: Array<
    Pick<Task, 'id' | 'title' | 'status' | 'priority' | 'latestHandoffId'>
  >;
  recentDecisions: Array<Pick<Decision, 'id' | 'title' | 'status'>>;
  openConflicts: Array<
    Pick<Conflict, 'id' | 'scopeType' | 'conflictType' | 'status'>
  >;
  mustReadTopics: Array<{ id: string; title: string; path: string }>;
  generatedAt: ISODateString;
}

export interface ProjectSyncState extends BaseEntity {
  projectId: EntityId;
  remoteProjectId?: string;
  syncEnabled: boolean;
  lastPushedEventId?: string;
  lastPulledEventId?: string;
  lastSyncAt?: ISODateString;
  syncStatus: SyncStatus;
}

type NewEntityFields = Omit<
  BaseEntity,
  'id' | 'schemaVersion' | 'createdAt' | 'updatedAt'
>;

function baseEntity(prefix: string): BaseEntity & NewEntityFields {
  const timestamp = nowIso();
  return {
    id: createId(prefix),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createProject(input: {
  title: string;
  rootPath: string;
  summary?: string;
  goals?: string[];
}): Project {
  return {
    ...baseEntity('proj'),
    title: input.title,
    summary: input.summary ?? input.title,
    goals: input.goals ?? [],
    status: 'active',
    rootPath: input.rootPath,
    importedContextCount: 0,
    activeWorkstreamIds: [],
    activeTaskIds: [],
    acceptedDecisionIds: [],
    ruleIds: [],
  };
}

export function createWorkstream(input: {
  projectId: string;
  title: string;
  summary?: string;
  locator?: string;
}): Workstream {
  return {
    ...baseEntity('ws'),
    projectId: input.projectId,
    title: input.title,
    summary: input.summary ?? input.title,
    status: 'active',
    ...(input.locator ? { locator: input.locator } : {}),
  };
}

export function createTask(input: {
  projectId: string;
  title: string;
  description?: string;
  goal?: string;
  priority?: Priority;
  workstreamId?: string;
}): Task {
  return {
    ...baseEntity('task'),
    projectId: input.projectId,
    ...(input.workstreamId ? { workstreamId: input.workstreamId } : {}),
    title: input.title,
    description: input.description ?? input.title,
    status: 'todo',
    priority: input.priority ?? 'medium',
    ownerType: 'unassigned',
    goal: input.goal ?? input.title,
    acceptanceCriteria: [],
    dependsOn: [],
    contextRefIds: [],
    decisionRefIds: [],
    ruleRefIds: [],
    openQuestions: [],
    riskNotes: [],
  };
}

export function createHandoff(input: {
  projectId: string;
  taskId: string;
  fromActor: string;
  toActor: string;
  summary: string;
  nextAction: string;
  doneItems?: string[];
  remainingItems?: string[];
  requiredContextRefs?: string[];
  warnings?: string[];
  unresolvedQuestions?: string[];
  confidence?: Confidence;
}): Handoff {
  return {
    ...baseEntity('handoff'),
    projectId: input.projectId,
    taskId: input.taskId,
    fromActor: input.fromActor,
    toActor: input.toActor,
    summary: input.summary,
    nextAction: input.nextAction,
    doneItems: input.doneItems ?? [],
    remainingItems: input.remainingItems ?? [],
    requiredContextRefs: input.requiredContextRefs ?? [],
    warnings: input.warnings ?? [],
    unresolvedQuestions: input.unresolvedQuestions ?? [],
    confidence: input.confidence ?? 'medium',
  };
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
  };
}

export function createDecision(input: {
  scopeType: Exclude<ArtifactScope, 'session' | 'policy'>;
  scopeId: string;
  title: string;
  decision: string;
  rationale: string;
  createdBy: string;
}): Decision {
  return {
    ...baseEntity('decision'),
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    title: input.title,
    decision: input.decision,
    rationale: input.rationale,
    status: 'proposed',
    relatedRuleIds: [],
    createdBy: input.createdBy,
  };
}

export function createRule(input: {
  scopeType: ArtifactScope;
  scopeId: string;
  title: string;
  body: string;
  updatedBy: string;
  source?: Rule['source'];
}): Rule {
  return {
    ...baseEntity('rule'),
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    title: input.title,
    body: input.body,
    priority: 100,
    source: input.source ?? 'user',
    updatedBy: input.updatedBy,
  };
}

export function createConflict(input: {
  projectId: string;
  scopeType: 'workstream' | 'task' | 'decision' | 'rule';
  scopeId: string;
  fieldPath: string;
  leftVersion: string;
  rightVersion: string;
  conflictType: ConflictType;
}): Conflict {
  return {
    ...baseEntity('conflict'),
    projectId: input.projectId,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    fieldPath: input.fieldPath,
    leftVersion: input.leftVersion,
    rightVersion: input.rightVersion,
    conflictType: input.conflictType,
    status: 'detected',
  };
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
