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
  /**
   * Origin store lane (M2 `(entity, writer)` projection). Undefined = self
   * (this store). Set from the consolidating event's `sourceProjectId` when it
   * came from a foreign origin store (a workspace union), so union reads can
   * group/filter shared memories by writer instead of folding them into local
   * truth. See docs/SoT/040.
   */
  sourceProjectId?: string;
}

/**
 * Provenance lane for the `(entity, writer)` projection (M2). Every event a
 * store appends itself shares ONE lane — {@link SELF_LANE} — so a single-writer
 * store keys exactly as it did pre-M2 (bare id). Events carried in by a
 * workspace union keep their originating store id as the lane, so "current X"
 * derivations and union reads can group by writer and never fold a foreign row
 * into local truth. The lane is `source_project_id` (the origin store), not the
 * actor: the same account across devices syncs into one store → one lane, so a
 * user's current task follows them across devices; only a different store (a
 * teammate, or a different folder/db) is a distinct lane. See docs/SoT/040.
 */
export const SELF_LANE = 'self';

/**
 * Joins lane + id in a composite state-map key. Entity ids and project ids are
 * never NUL-bearing, so the split back into (lane, id) is unambiguous.
 */
const LANE_SEP = String.fromCharCode(0);

/**
 * Composite state-map key. The self lane keeps the BARE id, so a single-writer
 * projection stays byte-identical to the pre-M2 one (every existing reader that
 * looks up `state.tasks[taskId]` still resolves). Foreign lanes get a prefix.
 */
function laneKey(lane: string, id: string): string {
  return lane === SELF_LANE ? id : `${lane}${LANE_SEP}${id}`;
}

/** Inverse of {@link laneKey}: recover the lane + id from a composite key. */
export function parseLaneKey(key: string): { lane: string; id: string } {
  const sep = key.indexOf(LANE_SEP);
  return sep === -1
    ? { lane: SELF_LANE, id: key }
    : { lane: key.slice(0, sep), id: key.slice(sep + 1) };
}

/** True for a self-lane key (no foreign prefix) — used to self-scope derivations. */
function isSelfKey(key: string): boolean {
  return !key.includes(LANE_SEP);
}

/**
 * The lane an event belongs to, relative to this store's own identity. A NULL
 * `sourceProjectId` (legacy/pre-3.0.0 events) and the store's own id both map
 * to {@link SELF_LANE}; any other origin store is a foreign lane.
 */
function laneOf(event: DomainEvent, selfProjectId: string | undefined): string {
  const source = event.sourceProjectId;
  if (source == null || source === selfProjectId) return SELF_LANE;
  return source;
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
    // Dedup is lane-scoped (M2): P3-a collapses SAME-store replica duplicates
    // (same lane, cross-device sync), NOT independent assertions from different
    // union writers — a foreign lane must never invalidate a self memory
    // (SoT-040). '\n' cannot appear in a lane id, observation id, or `kind`, so
    // the key parts can never collide across positions.
    const lane = memory.sourceProjectId ?? SELF_LANE;
    const key = `${lane}\n${[...ids].sort().join(',')}\n${memory.kind}\n${memory.text.trim().toLowerCase()}`;
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

  // This store's own identity. Every event whose `sourceProjectId` is NULL
  // (legacy) or equal to this belongs to SELF_LANE; anything else is a foreign
  // origin store carried in by a workspace union. The #30 one-identity
  // invariant guarantees exactly one project.created, so a prescan is safe.
  let selfProjectId: string | undefined;
  for (const event of events) {
    if (event.type === 'project.created') {
      selfProjectId = (event.payload as Project).id;
      break;
    }
  }

  for (const event of events) {
    const eventLane = laneOf(event, selfProjectId);
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
        state.tasks[laneKey(eventLane, event.scopeId)] = event.payload as Task;
        break;
      case 'task.updated':
        {
          const key = laneKey(eventLane, event.scopeId);
          const existingTask = state.tasks[key];
          if (!existingTask) break;
          state.tasks[key] = applyTaskUpdate(
            existingTask,
            event.payload as Partial<Task>,
            event.createdAt,
          );
        }
        break;
      case 'handoff.created':
        {
          const handoff = event.payload as Handoff;
          state.handoffs[laneKey(eventLane, handoff.id)] = handoff;
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
          state.sessions[laneKey(eventLane, session.id)] = session;
        }
        break;
      case 'session.completed':
      case 'session.abandoned':
        {
          const key = laneKey(eventLane, event.scopeId);
          const existing = state.sessions[key];
          if (!existing) break;
          state.sessions[key] = {
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
          const key = laneKey(eventLane, event.scopeId);
          const existing = state.sessions[key];
          if (!existing) break;
          state.sessions[key] = {
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
          const key = laneKey(eventLane, event.scopeId);
          const existing = state.sessions[key];
          if (!existing) break;
          state.sessions[key] = {
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
          const key = laneKey(eventLane, payload.sessionId);
          const existing = state.sessions[key];
          if (!existing) break;
          state.sessions[key] = {
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
          // Memories are id-keyed (ids are globally unique), but a foreign
          // memory carries its origin lane so union reads can group/filter it
          // without folding it into local truth. Self memories stay untagged
          // → byte-identical to the pre-M2 record.
          state.memories[memory.id] =
            eventLane === SELF_LANE
              ? memory
              : { ...memory, sourceProjectId: eventLane };
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
      // Self-scoped: a foreign writer's tasks (workspace union) must never be
      // foldable into THIS store's "current task" (SoT-040). isSelfKey drops
      // foreign-lane entries; single-writer stores are unaffected.
      activeTaskIds: Object.entries(state.tasks)
        .filter(
          ([key, task]) =>
            isSelfKey(key) &&
            task.status !== 'done' &&
            task.status !== 'cancelled',
        )
        .map(([, task]) => task.id),
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
    // Self-scoped like activeTaskIds: the injected startup index shows THIS
    // store's tasks; a union member's tasks reach the agent through the shared
    // channel (W3), never the local top-tasks fold (SoT-040).
    topTasks: Object.entries(state.tasks)
      .filter(
        ([key, task]) =>
          isSelfKey(key) &&
          task.status !== 'done' &&
          task.status !== 'cancelled',
      )
      .map(([, task]) => task)
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
