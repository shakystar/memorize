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
  /**
   * Stable repo identity that survives a path move (#145). Captured at create
   * time so `project setup` at a new path can detect a relocated repo instead
   * of silently minting an empty project and orphaning the original's memory.
   * Both optional + backward-compatible: legacy projects created before this
   * have neither, and fall back to the path/basename heuristic on detection.
   */
  originUrl?: string;
  rootCommit?: string;
}

export function createProject(input: {
  title: string;
  rootPath: string;
  summary?: string;
  goals?: string[];
  originUrl?: string;
  rootCommit?: string;
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
    ...(input.originUrl ? { originUrl: input.originUrl } : {}),
    ...(input.rootCommit ? { rootCommit: input.rootCommit } : {}),
  };
}
