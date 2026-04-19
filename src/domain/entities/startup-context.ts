import type { Conflict } from './conflict.js';
import type { Handoff } from './handoff.js';
import type { Task } from './task.js';

export interface StartupContextPayload {
  projectSummary: string;
  projectRules: string[];
  workstreamSummary?: string;
  task?: Task;
  latestHandoff?: Handoff;
  openConflicts: Conflict[];
  mustReadTopics: Array<{ id: string; title: string; path: string }>;
}
