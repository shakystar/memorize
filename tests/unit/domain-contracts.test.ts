import { describe, expect, it } from 'vitest';

import {
  createCheckpoint,
  createConflict,
  createDecision,
  createHandoff,
  createProject,
  createRule,
  createSession,
  createTask,
  createWorkstream,
  CURRENT_SCHEMA_VERSION,
} from '../../src/domain/index.js';

describe('domain constructors', () => {
  it('creates project-shaped entities with stable core metadata', () => {
    const project = createProject({
      title: 'Memorize',
      rootPath: '/tmp/memorize',
      summary: 'Shared context memory',
      goals: ['Reliable handoff'],
    });

    expect(project.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(project.title).toBe('Memorize');
    expect(project.rootPath).toBe('/tmp/memorize');
    expect(project.activeTaskIds).toEqual([]);
  });

  it('creates a task with sensible defaults', () => {
    const task = createTask({
      projectId: 'proj_1',
      title: 'Create startup payload',
    });

    expect(task.status).toBe('todo');
    expect(task.priority).toBe('medium');
    expect(task.goal).toBe('Create startup payload');
    expect(task.acceptanceCriteria).toEqual([]);
  });

  it('creates related entities with expected ownership fields', () => {
    const workstream = createWorkstream({
      projectId: 'proj_1',
      title: 'default',
    });
    const handoff = createHandoff({
      projectId: 'proj_1',
      taskId: 'task_1',
      fromActor: 'claude',
      toActor: 'codex',
      summary: 'Initial pass complete',
      nextAction: 'Continue implementation',
    });
    const checkpoint = createCheckpoint({
      projectId: 'proj_1',
      sessionId: 'session_1',
      summary: 'Checkpoint summary',
    });
    const decision = createDecision({
      scopeType: 'project',
      scopeId: 'proj_1',
      title: 'Use event log',
      decision: 'Append events first',
      rationale: 'Rebuildability',
      createdBy: 'user',
    });
    const rule = createRule({
      scopeType: 'project',
      scopeId: 'proj_1',
      title: 'Keep startup payload small',
      body: 'Never require raw transcripts on startup',
      updatedBy: 'user',
    });
    const conflict = createConflict({
      projectId: 'proj_1',
      scopeType: 'task',
      scopeId: 'task_1',
      fieldPath: 'status',
      leftVersion: 'todo',
      rightVersion: 'done',
      conflictType: 'state',
    });
    const session = createSession({
      projectId: 'proj_1',
      actor: 'codex',
    });

    expect(workstream.projectId).toBe('proj_1');
    expect(handoff.fromActor).toBe('claude');
    expect(checkpoint.sessionId).toBe('session_1');
    expect(decision.status).toBe('proposed');
    expect(rule.priority).toBe(100);
    expect(conflict.status).toBe('detected');
    expect(session.status).toBe('active');
  });
});
