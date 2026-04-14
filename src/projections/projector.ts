import { CURRENT_SCHEMA_VERSION, nowIso } from '../domain/common.js';
import type { DomainEvent } from '../domain/events.js';
import type {
  Checkpoint,
  Conflict,
  Decision,
  Handoff,
  MemoryIndex,
  Project,
  Rule,
  Task,
  Workstream,
} from '../domain/entities.js';

export interface ProjectState {
  project: Project | undefined;
  workstreams: Record<string, Workstream>;
  tasks: Record<string, Task>;
  handoffs: Record<string, Handoff>;
  checkpoints: Record<string, Checkpoint>;
  decisions: Record<string, Decision>;
  rules: Record<string, Rule>;
  conflicts: Record<string, Conflict>;
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
      default:
        break;
    }
  }

  if (state.project) {
    state.project = {
      ...state.project,
      activeWorkstreamIds: Object.keys(state.workstreams),
      activeTaskIds: Object.keys(state.tasks),
      acceptedDecisionIds: Object.values(state.decisions)
        .filter((decision) => decision.status === 'accepted')
        .map((decision) => decision.id),
      ruleIds: Object.values(state.rules).map((rule) => rule.id),
    };
  }

  return state;
}

function applyTaskUpdate(task: Task, patch: Partial<Task>): Task {
  return {
    ...task,
    ...patch,
    updatedAt: patch.updatedAt ?? nowIso(),
  };
}

export function buildMemoryIndex(state: ProjectState): MemoryIndex {
  if (!state.project) {
    throw new Error('Cannot build memory index without a project');
  }

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projectId: state.project.id,
    shortSummary: state.project.summary,
    activeWorkstreams: Object.values(state.workstreams).map((workstream) => ({
      id: workstream.id,
      title: workstream.title,
      summary: workstream.summary,
      status: workstream.status,
    })),
    topTasks: Object.values(state.tasks).map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      ...(task.latestHandoffId
        ? { latestHandoffId: task.latestHandoffId }
        : {}),
    })),
    recentDecisions: Object.values(state.decisions).map((decision) => ({
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
