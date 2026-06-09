import type { BaseEntity, EntityId, ISODateString } from '../common.js';
import { baseEntity } from './base.js';

export type ConflictType = 'state' | 'decision' | 'rule' | 'ownership';

export type ConflictStatus =
  | 'detected'
  | 'auto_resolved'
  | 'escalated'
  | 'resolved';

export interface Conflict extends BaseEntity {
  projectId: EntityId;
  scopeType: 'workstream' | 'task' | 'decision' | 'rule';
  scopeId: EntityId;
  fieldPath: string;
  leftVersion: string;
  rightVersion: string;
  conflictType: ConflictType;
  status: ConflictStatus;
  /**
   * P3-c — set when the two sides likely originated CONCURRENTLY (different
   * sessions/replicas, sync-delayed) rather than as a causal supersession. A
   * hint for the agent: the deterministic (createdAt,id) winner is convergent
   * across machines, but a concurrent fork may warrant a fresh explicit
   * decision. Precise causality detection is deferred to HLC (#39).
   */
  concurrent?: boolean;
  resolutionSummary?: string;
  resolvedBy?: string;
  resolvedAt?: ISODateString;
}

export function createConflict(input: {
  projectId: string;
  scopeType: 'workstream' | 'task' | 'decision' | 'rule';
  scopeId: string;
  fieldPath: string;
  leftVersion: string;
  rightVersion: string;
  conflictType: ConflictType;
  concurrent?: boolean;
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
    ...(input.concurrent ? { concurrent: true } : {}),
    status: 'detected',
  };
}
