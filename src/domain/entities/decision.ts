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
  /**
   * Set by a `decision.superseded` event to the id of the decision that
   * replaced this one. Invalidate-not-delete: the original entry is preserved
   * so point-in-time replays still see it. Backward-compatible (optional).
   */
  supersededBy?: EntityId;
}

/**
 * Payload of a `decision.superseded` event. Append-only correction: the
 * superseding decision is recorded as its own `decision.proposed` /
 * `decision.accepted` pair; this event only closes out the old one. The
 * original decision row stays so point-in-time replays remain reconstructable.
 */
export interface DecisionSupersededPayload {
  /** The decision this event marks as superseded. */
  supersedes: EntityId;
  /** The newer decision that replaces it. */
  supersededBy: EntityId;
  reason?: string;
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
