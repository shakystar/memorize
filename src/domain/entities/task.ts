import type { BaseEntity, EntityId } from '../common.js';
import { baseEntity } from './base.js';

export type TaskStatus =
  | 'todo'
  | 'in_progress'
  | 'blocked'
  | 'handoff_ready'
  | 'done'
  | 'cancelled';

export const PRIORITY_VALUES = ['low', 'medium', 'high'] as const;
export type Priority = (typeof PRIORITY_VALUES)[number];

export function isPriority(value: string): value is Priority {
  return (PRIORITY_VALUES as readonly string[]).includes(value);
}

export type OwnerType = 'human' | 'agent' | 'unassigned';

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

/**
 * Fields that grow item-by-item via `task.item-appended` events. Kept as a
 * closed allowlist so a synced event from another writer can never append
 * into an arbitrary Task property.
 */
export const TASK_APPENDABLE_FIELDS = [
  'acceptanceCriteria',
  'openQuestions',
  'riskNotes',
] as const;
export type TaskAppendableField = (typeof TASK_APPENDABLE_FIELDS)[number];

export interface TaskItemAppendedPayload {
  field: TaskAppendableField;
  text: string;
}

export function createTask(input: {
  projectId: string;
  title: string;
  description?: string;
  goal?: string;
  priority?: Priority;
  workstreamId?: string;
  acceptanceCriteria?: string[];
}): Task {
  return {
    ...baseEntity('task'),
    projectId: input.projectId,
    ...(input.workstreamId ? { workstreamId: input.workstreamId } : {}),
    title: input.title,
    // No title fallback: an absent description/goal stays empty rather than
    // masquerading as filled — consumers treat '' as absent.
    description: input.description ?? '',
    status: 'todo',
    priority: input.priority ?? 'medium',
    ownerType: 'unassigned',
    goal: input.goal ?? '',
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    dependsOn: [],
    contextRefIds: [],
    decisionRefIds: [],
    ruleRefIds: [],
    openQuestions: [],
    riskNotes: [],
  };
}
