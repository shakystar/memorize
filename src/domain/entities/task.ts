import type { BaseEntity, EntityId } from '../common.js';
import { baseEntity } from './base.js';

export type TaskStatus =
  | 'todo'
  | 'in_progress'
  | 'blocked'
  | 'handoff_ready'
  | 'done';

export type Priority = 'low' | 'medium' | 'high';
export type OwnerType = 'human' | 'agent' | 'unassigned';
export type ChecklistStatus = 'todo' | 'doing' | 'done' | 'skipped';

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
