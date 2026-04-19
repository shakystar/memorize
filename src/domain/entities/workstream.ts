import type { BaseEntity, EntityId } from '../common.js';
import { baseEntity } from './base.js';

export type WorkstreamStatus = 'active' | 'paused' | 'closed';

export interface Workstream extends BaseEntity {
  projectId: EntityId;
  title: string;
  summary: string;
  status: WorkstreamStatus;
  locator?: string;
}

export function createWorkstream(input: {
  projectId: string;
  title: string;
  summary?: string;
  locator?: string;
}): Workstream {
  return {
    ...baseEntity('ws'),
    projectId: input.projectId,
    title: input.title,
    summary: input.summary ?? input.title,
    status: 'active',
    ...(input.locator ? { locator: input.locator } : {}),
  };
}
