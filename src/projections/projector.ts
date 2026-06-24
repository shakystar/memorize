import { CURRENT_SCHEMA_VERSION, nowIso } from '../domain/common.js';
import type { DomainEvent } from '../domain/events.js';
import type {
  Checkpoint,
  Conflict,
  ConsolidatedMemory,
  Decision,
  DecisionSupersededPayload,
  Handoff,
  MemoryIndex,
  MemorySupersededPayload,
  Observation,
  Project,
  Rule,
  Session,
  SessionHeartbeatPayload,
  Task,
  Workstream,
} from '../domain/entities.js';

/**
 * A consolidated memory plus its replay-derived validity window. The
 * invalidation fields come from `memory.superseded` events (bi-temporal,
 * invalidate-not-delete) — fully deterministic under replay. Retrieval
 * reinforcement (`last_accessed_at`) is deliberately NOT here: it is a
 * projection-table-only, best-effort column (decision ⑤).
 */
export interface MemoryRecord extends ConsolidatedMemory {
  invalidAt?: string;
  supersededBy?: string;
  /**
   * Cross-machine dedup loser marker (P3-a auto-convergence): set to the
   * winning memory's id when this record was collapsed as a duplicate (same
   * `sourceObservationIds` distilled concurrently on two replicas). Distinct
   * from `supersededBy` (event-driven bi-temporal contradiction): `dedupedBy`
   * is projection-computed, deterministic, and carries no "what was true then"
   * value. Like `supersededBy`, it also closes the validity window via
   * `invalidAt` so `listValidMemories` excludes it with no query change.
   */
  dedupedBy?: string;
}

export interface ProjectState {
  project: Project | undefined;
  workstreams: Record<string, Workstream>;
  tasks: Record<string, Task>;
  handoffs: Record<string, Handoff>;
  checkpoints: Record<string, Checkpoint>;
  decisions: Record<string, Decision>;
  rules: Record<string, Rule>;
  conflicts: Record<string, Conflict>;
  sessions: Record<string, Session>;
  observations: Record<string, Observation>;
  memories: Record<string, MemoryRecord>;
}

/**
 * Collapse duplicate consolidated memories in place. Groups still-valid
 * memories by their EXACT `sourceObservationIds` set (sorted) PLUS `kind` PLUS
 * normalized text (trim + lowercase), and for any group with >1 member keeps
 * the deterministic winner — `(createdAt, id)` ascending — marking the rest as
 * dedup losers (`invalidAt` = winner.createdAt, `dedupedBy` = winner.id).
 * Kind + text are part of the key because one consolidate() batch attaches the
 * SAME boundary window to every memory it extracts (#49) — same window with
 * different text is N distinct memories, not duplicates; only same window +
 * same kind + same text (cross-machine re-consolidation, event replay) is a
 * true duplicate. Empty/absent source sets never group (each stands alone).
 * Already-superseded memories are skipped so a genuine contradiction stays
 * invalid and is never chosen. Pure + content-keyed → identical result on
 * every replica regardless of sync order.
 */
function dedupeMemoriesBySource(memories: Record<string, MemoryRecord>): void {
  const groups = new Map<string, MemoryRecord[]>();
  for (const memory of Object.values(memories)) {
    if (memory.invalidAt) continue;
    const ids = memory.sourceObservationIds ?? [];
    if (ids.length === 0) continue;
    // '\n' separator cannot appear in observation ids or `kind`, so the three
    // key parts can never collide across positions.
    const key = `${[...ids].sort().join(',')}\n${memory.kind}\n${memory.text.trim().toLowerCase()}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(memory);
    else groups.set(key, [memory]);
  }
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) =>
      a.createdAt !== b.createdAt
        ? a.createdAt < b.createdAt
          ? -1
          : 1
        : a.id < b.id
          ? -1
          : 1,
    );
    const winner = members[0]!;
    for (const loser of members.slice(1)) {
      memories[loser.id] = {
        ...loser,
        invalidAt: winner.createdAt,
        dedupedBy: winner.id,
      };
    }
  }
}

export function reduceProjectState(events: DomainEvent[]): ProjectState {
  const state: ProjectState = {
    project: undefined,
    workstreams: {},
    tasks: {},
    handoffs: {},
    checkpoints: {},
    decisions: {},
    rules: {},
    conflicts: {},
    sessions: {},
    observations: {},
    memories: {},
  };

  for (const event of events) {
    switch (event.type) {
      case 'project.created': {
        // True-replica invariant (#30): a project's event log holds exactly
        // ONE identity. Two distinct project.created ids in one store means a
        // cross-machine bind clobbered identity (the pre-clone-on-bind bug).
        // Fail LOUD instead of silently letting the last-by-seq id win and
        // leaving getProjectProjection() returning an empty/wrong row. A
        // repeated SAME id (idempotent re-pull) is fine.
        const incoming = event.payload as Project;
        if (state.project && state.project.id !== incoming.id) {
          throw new Error(
            `Divergent project identity in event log: project.created for ` +
              `${state.project.id} and ${incoming.id} in the same store (#30). ` +
              `Re-clone into a fresh directory — in-place repair of a diverged ` +
              `log is unsupported.`,
          );
        }
        state.project = incoming;
        break;
      }
      case 'project.updated':
        if (state.project) {
          state.project = {
            ...state.project,
            ...(event.payload as Partial<Project>),
          };
        }
        break;
      case 'workstream.created':
        state.workstreams[event.scopeId] = event.payload as Workstream;
        break;
      case 'task.created':
        state.tasks[event.scopeId] = event.payload as Task;
        break;
      case 'task.updated':
        {
          const existingTask = state.tasks[event.scopeId];
          if (!existingTask) break;
          state.tasks[event.scopeId] = applyTaskUpdate(
            existingTask,
            event.payload as Partial<Task>,
            event.createdAt,
          );
        }
        break;
      case 'handoff.created':
        {
          const handoff = event.payload as Handoff;
          state.handoffs[handoff.id] = handoff;
        }
        break;
      case 'checkpoint.created':
        {
          const checkpoint = event.payload as Checkpoint;
          state.checkpoints[checkpoint.id] = checkpoint;
        }
        break;
      case 'decision.proposed':
      case 'decision.accepted':
        state.decisions[event.scopeId] = event.payload as Decision;
        break;
      case 'decision.superseded':
        {
          // Invalidate-not-delete (mirror memory.superseded): mark the old
          // decision superseded so acceptedDecisionIds drops it, but keep the
          // entry so point-in-time replays still see what was decided then.
          // The new (superseding) decision enters via its own decision.accepted.
          const payload = event.payload as DecisionSupersededPayload;
          const existing = state.decisions[payload.supersedes];
          if (!existing) break;
          state.decisions[payload.supersedes] = {
            ...existing,
            status: 'superseded',
            supersededBy: payload.supersededBy,
          };
        }
        break;
      case 'rule.upserted':
        state.rules[(event.payload as Rule).id] = event.payload as Rule;
        break;
      case 'conflict.detected':
      case 'conflict.resolved':
        state.conflicts[event.scopeId] = event.payload as Conflict;
        break;
      case 'session.started':
        {
          const session = event.payload as Session;
          state.sessions[session.id] = session;
        }
        break;
      case 'session.completed':
      case 'session.abandoned':
        {
          const existing = state.sessions[event.scopeId];
          if (!existing) break;
          state.sessions[event.scopeId] = {
            ...existing,
            status: event.type === 'session.completed' ? 'completed' : 'abandoned',
            endedAt: event.createdAt,
            lastSeenAt: event.createdAt,
            updatedAt: event.createdAt,
          };
        }
        break;
      case 'session.paused':
        {
          // Agent CLI exited cleanly (Claude SessionEnd) but the
          // session is intentionally kept resumable. The cwd pointer
          // stays so a later `claude --resume` / `codex resume` can
          // reattach via agentSessionId match. Reap sweeps still
          // catch this status if it goes stale without a resume.
          const existing = state.sessions[event.scopeId];
          if (!existing) break;
          state.sessions[event.scopeId] = {
            ...existing,
            status: 'paused',
            lastSeenAt: event.createdAt,
            updatedAt: event.createdAt,
          };
        }
        break;
      case 'session.resumed':
        {
          // Same agent session re-attached (Claude --resume on the
          // same UUID, codex resume). Flip back to 'active' if we had
          // marked it 'paused' on the prior SessionEnd, and bump
          // activity so the picker sees it as fresh again.
          const existing = state.sessions[event.scopeId];
          if (!existing) break;
          state.sessions[event.scopeId] = {
            ...existing,
            status: 'active',
            lastSeenAt: event.createdAt,
            updatedAt: event.createdAt,
          };
        }
        break;
      case 'session.heartbeat':
        {
          const payload = event.payload as SessionHeartbeatPayload;
          const existing = state.sessions[payload.sessionId];
          if (!existing) break;
          state.sessions[payload.sessionId] = {
            ...existing,
            lastSeenAt: payload.at,
            updatedAt: payload.at,
          };
        }
        break;
      case 'observation.captured':
        {
          const observation = event.payload as Observation;
          state.observations[observation.id] = observation;
        }
        break;
      case 'memory.consolidated':
        {
          const memory = event.payload as ConsolidatedMemory;
          state.memories[memory.id] = memory;
        }
        break;
      case 'memory.superseded':
        {
          // Invalidate-not-delete: close the old memory's validity window
          // at the superseding event's timestamp. The original entry stays
          // so point-in-time replays still see what was true then.
          const payload = event.payload as MemorySupersededPayload;
          const existing = state.memories[payload.supersedes];
          if (!existing) break;
          state.memories[payload.supersedes] = {
            ...existing,
            invalidAt: event.createdAt,
            supersededBy: payload.supersededBy,
          };
        }
        break;
      default:
        break;
    }
  }

  // Cross-machine duplicate dedup (P3-a auto-convergence). Two replicas that
  // consolidate the SAME observation window before syncing each emit a
  // memory.consolidated with identical sourceObservationIds → duplicates once
  // merged. Collapse them deterministically here (pure function of the merged
  // log → every replica picks the same winner, no new event), so
  // listValidMemories / search / retrieval all converge to one record.
  dedupeMemoriesBySource(state.memories);

  if (state.project) {
    state.project = {
      ...state.project,
      activeWorkstreamIds: Object.values(state.workstreams)
        .filter((workstream) => workstream.status !== 'closed')
        .map((workstream) => workstream.id),
      activeTaskIds: Object.values(state.tasks)
        .filter((task) => task.status !== 'done' && task.status !== 'cancelled')
        .map((task) => task.id),
      acceptedDecisionIds: Object.values(state.decisions)
        .filter((decision) => decision.status === 'accepted')
        .map((decision) => decision.id),
      ruleIds: Object.values(state.rules).map((rule) => rule.id),
    };
  }

  return state;
}

function applyTaskUpdate(
  task: Task,
  patch: Partial<Task>,
  eventCreatedAt: string,
): Task {
  return {
    ...task,
    ...patch,
    // Fall back to the triggering event's createdAt (NOT wall-clock
    // nowIso()) so replaying the same event log is deterministic.
    updatedAt: patch.updatedAt ?? eventCreatedAt,
  };
}

export const MAX_TOP_TASKS = 20;
export const MAX_RECENT_DECISIONS = 20;

function byUpdatedAtDesc<T extends { updatedAt: string }>(a: T, b: T): number {
  return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
}

export function buildMemoryIndex(state: ProjectState): MemoryIndex {
  if (!state.project) {
    throw new Error('Cannot build memory index without a project');
  }

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projectId: state.project.id,
    shortSummary: state.project.summary,
    activeWorkstreams: Object.values(state.workstreams)
      .filter((workstream) => workstream.status !== 'closed')
      .map((workstream) => ({
        id: workstream.id,
        title: workstream.title,
        summary: workstream.summary,
        status: workstream.status,
      })),
    topTasks: Object.values(state.tasks)
      .filter((task) => task.status !== 'done' && task.status !== 'cancelled')
      .sort(byUpdatedAtDesc)
      .slice(0, MAX_TOP_TASKS)
      .map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        ...(task.latestHandoffId
          ? { latestHandoffId: task.latestHandoffId }
          : {}),
      })),
    recentDecisions: Object.values(state.decisions)
      .filter((decision) => decision.status === 'accepted')
      .sort(byUpdatedAtDesc)
      .slice(0, MAX_RECENT_DECISIONS)
      .map((decision) => ({
        id: decision.id,
        title: decision.title,
        status: decision.status,
      })),
    openConflicts: Object.values(state.conflicts).map((conflict) => ({
      id: conflict.id,
      scopeType: conflict.scopeType,
      conflictType: conflict.conflictType,
      status: conflict.status,
    })),
    mustReadTopics: Object.values(state.rules)
      .filter((rule) => rule.source === 'imported')
      .map((rule) => ({
        id: rule.id,
        title: rule.title,
        path: `topic:${rule.id}`,
      })),
    generatedAt: nowIso(),
  };
}
