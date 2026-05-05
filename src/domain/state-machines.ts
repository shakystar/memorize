import { MemorizeError } from '../shared/errors.js';
import type {
  ConflictStatus,
  Session,
  SyncStatus,
  TaskStatus,
  WorkstreamStatus,
} from './entities.js';

const taskTransitions: Record<TaskStatus, TaskStatus[]> = {
  todo: ['in_progress', 'blocked'],
  in_progress: ['handoff_ready', 'blocked'],
  handoff_ready: ['in_progress', 'done'],
  blocked: ['in_progress', 'handoff_ready'],
  done: [],
};

const workstreamTransitions: Record<WorkstreamStatus, WorkstreamStatus[]> = {
  active: ['paused', 'closed'],
  paused: ['active', 'closed'],
  closed: [],
};

const sessionTransitions: Record<Session['status'], Session['status'][]> = {
  active: ['paused', 'completed', 'abandoned'],
  // `paused` ↔ `active` is the SessionEnd → resume cycle: SessionEnd
  // pauses (pointer kept), claude --resume / codex resume reactivates.
  // `paused → abandoned` is the reap path when no resume happens
  // before the staleness threshold.
  paused: ['active', 'completed', 'abandoned'],
  completed: [],
  abandoned: [],
};

const conflictTransitions: Record<ConflictStatus, ConflictStatus[]> = {
  detected: ['auto_resolved', 'escalated', 'resolved'],
  auto_resolved: [],
  escalated: ['resolved'],
  resolved: [],
};

const syncTransitions: Record<SyncStatus, SyncStatus[]> = {
  idle: ['syncing'],
  syncing: ['idle', 'conflicted', 'offline'],
  conflicted: ['syncing'],
  offline: ['syncing'],
};

function assertTransition<T extends string>(
  label: string,
  from: T,
  to: T,
  transitions: Record<T, T[]>,
): void {
  if (!transitions[from].includes(to)) {
    throw new MemorizeError(`Invalid ${label} transition: ${from} -> ${to}`);
  }
}

export function assertTaskStatusTransition(
  from: TaskStatus,
  to: TaskStatus,
): void {
  assertTransition('task status', from, to, taskTransitions);
}

export function assertWorkstreamStatusTransition(
  from: WorkstreamStatus,
  to: WorkstreamStatus,
): void {
  assertTransition('workstream status', from, to, workstreamTransitions);
}

export function assertSessionStatusTransition(
  from: Session['status'],
  to: Session['status'],
): void {
  assertTransition('session status', from, to, sessionTransitions);
}

export function assertConflictStatusTransition(
  from: ConflictStatus,
  to: ConflictStatus,
): void {
  assertTransition('conflict status', from, to, conflictTransitions);
}

export function assertSyncStatusTransition(
  from: SyncStatus,
  to: SyncStatus,
): void {
  assertTransition('sync status', from, to, syncTransitions);
}
