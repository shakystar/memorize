import type { ISODateString } from '../common.js';
import type { Checkpoint } from './checkpoint.js';
import type { Conflict } from './conflict.js';
import type { Handoff } from './handoff.js';
import type { Task, TaskStatus } from './task.js';

export interface OtherActiveTaskAssignment {
  sessionId: string;
  actor: string;
  lastSeenAt: ISODateString;
  /** Human-friendly relative freshness label, e.g. "active 5m ago", "stale ~2h ago". */
  freshness: string;
}

export interface OtherActiveTask {
  id: string;
  title: string;
  status: TaskStatus;
  assignment: OtherActiveTaskAssignment;
}

export interface StartupContextPayload {
  projectSummary: string;
  projectRules: string[];
  workstreamSummary?: string;
  task?: Task;
  latestHandoff?: Handoff;
  /** Most recent PostCompact checkpoint for the picked-up task. Renderer
   *  surfaces the compact summary so the resumed session has continuity
   *  with the prior context that was compacted away. Undefined when the
   *  task has no checkpoint or no task was selected. */
  latestCheckpoint?: Checkpoint;
  openConflicts: Conflict[];
  mustReadTopics: Array<{ id: string; title: string; path: string }>;
  /** Tasks currently being worked on by other agent sessions (excluding the
   *  caller's own task). Renderer surfaces this so an agent can pick a
   *  different task and avoid duplicate work. Empty when no parallel
   *  sessions are active. */
  otherActiveTasks?: OtherActiveTask[];
}
