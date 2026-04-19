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
