import type { BaseEntity, EntityId } from '../common.js';
import { baseEntity, type ArtifactScope } from './base.js';

export interface Rule extends BaseEntity {
  scopeType: ArtifactScope;
  scopeId: EntityId;
  title: string;
  body: string;
  priority: number;
  source: 'user' | 'team' | 'imported' | 'inferred';
  updatedBy: string;
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
