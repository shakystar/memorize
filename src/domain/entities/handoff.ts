import type { BaseEntity, EntityId } from '../common.js';
import { baseEntity } from './base.js';

export const CONFIDENCE_VALUES = ['low', 'medium', 'high'] as const;
export type Confidence = (typeof CONFIDENCE_VALUES)[number];

export function isConfidence(value: string): value is Confidence {
  return (CONFIDENCE_VALUES as readonly string[]).includes(value);
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
