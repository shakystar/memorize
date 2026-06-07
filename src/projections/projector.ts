import { CURRENT_SCHEMA_VERSION, nowIso } from '../domain/common.js';
import type { DomainEvent } from '../domain/events.js';
import type {
  Checkpoint,
  Conflict,
  ConsolidatedMemory,
  Decision,
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
      case 'project.created':
        state.project = event.payload as Project;
        break;
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

  if (state.project) {
    state.project = {
      ...state.project,
      activeWorkstreamIds: Object.values(state.workstreams)
        .filter((workstream) => workstream.status !== 'closed')
        .map((workstream) => workstream.id),
      activeTaskIds: Object.values(state.tasks)
        .filter((task) => task.status !== 'done')
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
      .filter((task) => task.status !== 'done')
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
