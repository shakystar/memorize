import type { ISODateString } from '../common.js';
import type { Checkpoint } from './checkpoint.js';
import type { Conflict } from './conflict.js';
import type { Handoff } from './handoff.js';
import type { ConsolidatedMemoryKind, ObservationSignal } from './memory.js';
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
  /** SoT-041 inbox: pending task requests addressed to THIS project by other
   *  workspace member projects. Present only when non-empty. The agent should
   *  accept (`memorize task request accept <id>`) or decline with a reason —
   *  silence leaves the requester waiting. */
  inboundTaskRequests?: Array<{
    id: string;
    fromProjectId: string;
    title: string;
    goal: string;
    createdAt: ISODateString;
  }>;
  /** CLS long-term layer: consolidated decisions/rationale/progress picked
   *  by retrieval-time ranking (recency decay + salience + relevance).
   *  Already budget-trimmed by the retrieval service. */
  consolidatedMemories?: Array<{
    id: string;
    kind: ConsolidatedMemoryKind;
    text: string;
    salience: number;
    createdAt: ISODateString;
  }>;
  /** Path A: global personal memory (cross-project preferences, working style)
   *  surfaced in its OWN dedicated channel, ranked by salience — NOT mixed into
   *  the project `consolidatedMemories` pool. A small fixed slot (top-N) so it
   *  never crowds out project memory; rendered as a distinct section so the
   *  personal/project boundary is visible in context too. */
  personalMemories?: Array<{
    id: string;
    kind: ConsolidatedMemoryKind;
    text: string;
    salience: number;
  }>;
  /** W3: the workspace shared channel — other members' memories read from the
   *  union lane and labelled by writer (origin store), NEVER folded into the
   *  local `consolidatedMemories` truth (SoT-010/040). Selected under its OWN
   *  budget pool so it cannot crowd the private channels. Absent when the
   *  project is not workspace-bound or carries no foreign-lane memories.
   *  Entries arrive grouped by writer so renderers can label lanes by
   *  adjacency. */
  sharedMemories?: Array<{
    id: string;
    kind: ConsolidatedMemoryKind;
    text: string;
    salience: number;
    /** Origin store lane of the writing member (`proj_…`) — the provenance
     *  label; maps to a person via the workspace roster when online. */
    writer: string;
  }>;
  /** CLS short-term layer: tail of the previous session's raw observations
   *  (high-signal only — the capture filter already rejected chatter). */
  recentObservations?: Array<{
    signal: ObservationSignal;
    toolName?: string;
    summary?: string;
    createdAt: ISODateString;
  }>;
  /** Raw transcript detail retrieved for the current task (v10) — verbatim
   *  conversation content that consolidation compressed away, surfaced ALONGSIDE
   *  (never replacing) the consolidated memories. Already budget-trimmed; rendered
   *  at a low priority so it drops before memories under budget pressure. */
  rawSegments?: Array<{ id: string; text: string }>;
}
