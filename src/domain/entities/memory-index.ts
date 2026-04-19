import type { EntityId, ISODateString } from '../common.js';
import type { Conflict } from './conflict.js';
import type { Decision } from './decision.js';
import type { Task } from './task.js';
import type { Workstream } from './workstream.js';

export interface MemoryIndex {
  schemaVersion: string;
  projectId: EntityId;
  shortSummary: string;
  activeWorkstreams: Array<
    Pick<Workstream, 'id' | 'title' | 'summary' | 'status'>
  >;
  topTasks: Array<
    Pick<Task, 'id' | 'title' | 'status' | 'priority' | 'latestHandoffId'>
  >;
  recentDecisions: Array<Pick<Decision, 'id' | 'title' | 'status'>>;
  openConflicts: Array<
    Pick<Conflict, 'id' | 'scopeType' | 'conflictType' | 'status'>
  >;
  mustReadTopics: Array<{ id: string; title: string; path: string }>;
  generatedAt: ISODateString;
}
