import type { BaseEntity, EntityId } from '../common.js';
import { baseEntity } from './base.js';

export type ProjectStatus = 'active' | 'paused' | 'archived';

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
