import { CURRENT_SCHEMA_VERSION, nowIso } from '../domain/common.js';
import type { DomainEvent } from '../domain/events.js';
import { TASK_APPENDABLE_FIELDS } from '../domain/entities.js';
import type {
  Checkpoint,
  Conflict,
  ConsolidatedMemory,
  Decision,
  DecisionSupersededPayload,
  Handoff,
  MemoryIndex,
  MemoryRetractedPayload,
  MemorySupersededPayload,
  Observation,
  Project,
  Rule,
  Session,
  SessionHeartbeatPayload,
  Task,
  TaskItemAppendedPayload,
  TaskRequest,
  TaskRequestAcceptedPayload,
  TaskRequestDeclinedPayload,
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
  /**
   * Tombstone marker (M3, SoT-050): the timestamp of the `memory.retracted`
   * event that removed this memory. Like `dedupedBy`/`supersededBy` it also
   * closes the validity window via `invalidAt`, so `listValidMemories`
   * excludes it with no query change; UNLIKE supersede it carries no
   * replacement and drops the memory from the FTS index entirely (a retract is
   * a stronger "make it go away" than a bi-temporal supersede). The original
   * row + event are preserved, so the retraction is reversible (a later
   * retract-the-retraction) and fully auditable.
   */
  retractedAt?: string;
  /** The writer (originating actor) who retracted it — provenance for a future owner-only global retract (SoT-040/H030). */
  retractedBy?: string;
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
 * The lane an event belongs to, relative to this store's own identity. A
 * stamped `sourceProjectId` is authoritative: the store's own id maps to
 * {@link SELF_LANE}, any other origin store is a foreign lane.
 *
 * A NULL `sourceProjectId` (legacy, authored before Phase 0 provenance) needs
 * `isUnion` to disambiguate. In a single-identity log it is the store's own
 * history → self (pre-3.0.0 behavior, and the cross-dir migrate round-trip
 * where the dir id differs from the genesis). In a workspace UNION log a
 * member's whole-DB push carries its legacy events NULL-src as-is — nothing
 * on the wire backfills them — so `event.projectId` is the origin proxy:
 * a foreign member's legacy block rides in under ITS projectId and must not
 * land in the self lane (it tripped doctor's one-SELF-identity check and
 * misattributed foreign memories as self during the 3.0.0 dogfood).
 */
function laneOf(
  event: DomainEvent,
  selfProjectId: string | undefined,
  isUnion: boolean,
): string {
  const source = event.sourceProjectId;
  if (source != null) {
    return source === selfProjectId ? SELF_LANE : source;
  }
  if (!isUnion || event.projectId === selfProjectId) return SELF_LANE;
  return event.projectId;
}

/** A project visible in this store's union — self or a workspace member
 *  whose genesis arrived via whole-DB sync (SoT-040). The local roster that
 *  `workspace sources` and `--to` resolution read; no Hub call involved. */
export interface MemberProject {
  id: string;
  title: string;
  isSelf: boolean;
}

export interface ProjectState {
  project: Project | undefined;
  workstreams: Record<string, Workstream>;
  tasks: Record<string, Task>;
  taskRequests: Record<string, TaskRequest>;
  memberProjects: Record<string, MemberProject>;
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

export function reduceProjectState(
  events: DomainEvent[],
  selfProjectId?: string,
): ProjectState {
  const state: ProjectState = {
    project: undefined,
    workstreams: {},
    tasks: {},
    taskRequests: {},
    memberProjects: {},
    handoffs: {},
    checkpoints: {},
    decisions: {},
    rules: {},
    conflicts: {},
    sessions: {},
    observations: {},
    memories: {},
  };

  // This store's own identity. Every event whose `sourceProjectId` equals this
  // belongs to SELF_LANE; anything else is a foreign origin store carried in by
  // a workspace union. NULL provenance (legacy) resolves via `laneOf`: self in
  // a single-identity log, by the event's own projectId in a union log.
  //
  // AUTHORITATIVE when the caller passes `selfProjectId` — every real projection
  // path (rebuildProjectProjection, getProjectStateAtRevision) knows the store's
  // own proj_. A workspace union legitimately carries MULTIPLE distinct
  // project.created (one per member); anchoring self on "first by seq" would
  // mis-identify self when a foreign member's genesis synced in at a lower seq
  // (SoT-021). When the caller omits it, fall back to the first project.created —
  // correct for a single-identity (non-union) log (migrate sanity-check, ad-hoc).
  // Only an EXPLICIT selfProjectId lets us treat a foreign project.created as
  // provenance (union-safe). Without it we cannot tell a legitimate union
  // genesis from a #30 identity clobber, so we keep the strict divergent-throw.
  const hasAuthoritativeSelf = selfProjectId !== undefined;
  // Prescan the genesis events: the self-lane anchor + whether this is a workspace
  // union (MORE THAN ONE distinct project.created id — one per member's whole-DB
  // union). A single-genesis log keeps legacy behavior even when the store's dir
  // id differs from the genesis (e.g. a cross-dir migrate round-trip), so the
  // provenance-skip below is gated on `isUnion`.
  const genesisIds = new Set<string>();
  let firstGenesisId: string | undefined;
  for (const event of events) {
    if (event.type === 'project.created') {
      const id = (event.payload as Project).id;
      if (firstGenesisId === undefined) firstGenesisId = id;
      genesisIds.add(id);
    }
  }
  const isUnion = genesisIds.size > 1;
  const selfId = selfProjectId ?? firstGenesisId;

  for (const event of events) {
    const eventLane = laneOf(event, selfId, isUnion);
    switch (event.type) {
      case 'project.created': {
        const incoming = event.payload as Project;
        // SoT-041 roster: every genesis in the union names a member project.
        // Recorded before the foreign-genesis skip so provenance labels still
        // become addressable targets.
        state.memberProjects[incoming.id] = {
          id: incoming.id,
          title: incoming.title,
          isSelf: incoming.id === selfId,
        };
        // Workspace union (SoT-021/022): with MULTIPLE distinct member genesis in
        // one store, only the authoritative self proj_ is identity; a non-self
        // member genesis is a PROVENANCE label — skip it (no adopt, no throw). Its
        // entities already live in a foreign lane (laneOf keyed on sourceProjectId).
        // Gated on isUnion so a single-genesis log is untouched (legacy/migrate).
        if (hasAuthoritativeSelf && isUnion && incoming.id !== selfId) {
          break;
        }
        // True-replica invariant (#30): a store's OWN log holds exactly ONE
        // identity. Two distinct SELF project.created ids means a cross-machine
        // bind clobbered identity (the pre-clone-on-bind bug). Fail LOUD instead
        // of silently letting the last-by-seq id win and leaving
        // getProjectProjection() returning an empty/wrong row. A repeated SAME id
        // (idempotent re-pull) is fine. (When selfId is omitted this still guards
        // a single-identity log exactly as before.)
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
      case 'task.item-appended':
        {
          const key = laneKey(eventLane, event.scopeId);
          const existingTask = state.tasks[key];
          if (!existingTask) break;
          const payload = event.payload as TaskItemAppendedPayload;
          // Closed allowlist: a synced event from another writer must not be
          // able to append into an arbitrary Task property.
          if (!TASK_APPENDABLE_FIELDS.includes(payload.field)) break;
          if (typeof payload.text !== 'string') break;
          state.tasks[key] = {
            ...existingTask,
            [payload.field]: [...existingTask[payload.field], payload.text],
            updatedAt: event.createdAt,
          };
        }
        break;
      case 'task.requested':
        state.taskRequests[laneKey(eventLane, event.scopeId)] =
          event.payload as TaskRequest;
        break;
      case 'task.request-accepted': {
        // Cross-lane fold: the accept lives in the TARGET's lane but resolves
        // a request stored under the REQUESTER's lane key — match by id.
        const payload = event.payload as TaskRequestAcceptedPayload;
        const key = Object.keys(state.taskRequests).find(
          (k) => parseLaneKey(k).id === payload.requestId,
        );
        if (!key) break;
        state.taskRequests[key] = {
          ...state.taskRequests[key]!,
          status: 'accepted',
          resolvedByTaskId: payload.taskId,
          updatedAt: event.createdAt,
        };
        break;
      }
      case 'task.request-declined': {
        const payload = event.payload as TaskRequestDeclinedPayload;
        const key = Object.keys(state.taskRequests).find(
          (k) => parseLaneKey(k).id === payload.requestId,
        );
        if (!key) break;
        state.taskRequests[key] = {
          ...state.taskRequests[key]!,
          status: 'declined',
          declineReason: payload.reason,
          updatedAt: event.createdAt,
        };
        break;
      }
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
      case 'memory.retracted':
        {
          // Tombstone (SoT-050): close the memory's validity window like a
          // supersede, but with NO replacement and a distinct `retractedAt`
          // marker (reversible, audit-preserving). Lane-aware: a retract only
          // takes effect within its OWN lane — a self-authored retract removes
          // a self memory; a union writer's retract removes its own lane's
          // memory. A cross-lane retract is the owner-only GLOBAL retract
          // (W-c, SoT-040/050, Hub H030): the gateway never parses payloads,
          // so the rule is judged HERE, from the role the event itself carries
          // (`writerRole`, stamped by the authoring client after a live
          // control-plane check — see MemoryRetractedPayload for why the role
          // must ride the event instead of being looked up at projection time).
          const payload = event.payload as MemoryRetractedPayload;
          const existing = state.memories[payload.retracts];
          if (!existing) break;
          const targetLane = existing.sourceProjectId ?? SELF_LANE;
          if (eventLane !== targetLane && payload.writerRole !== 'owner') break;
          state.memories[payload.retracts] = {
            ...existing,
            // Keep an earlier supersede/dedup window if one already closed it;
            // otherwise the window closes at the retraction.
            invalidAt: existing.invalidAt ?? event.createdAt,
            retractedAt: event.createdAt,
            ...(event.writer ? { retractedBy: event.writer } : {}),
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
