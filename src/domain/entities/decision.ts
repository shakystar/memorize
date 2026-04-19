import type { BaseEntity, EntityId } from '../common.js';
import { baseEntity, type ArtifactScope } from './base.js';

export type DecisionStatus =
  | 'proposed'
  | 'accepted'
  | 'superseded'
  | 'rejected';

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
