import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConflict, createDecision, createRule } from '../../src/domain/entities.js';
import { createProject } from '../../src/services/project-service.js';
import { rebuildProjectProjection } from '../../src/services/projection-store.js';
import { startSession } from '../../src/services/session-service.js';
import { createTask, updateTask } from '../../src/services/task-service.js';
import { appendEvent } from '../../src/storage/event-store.js';
import { closeAll, getDb } from '../../src/storage/db.js';

let sandbox: string;
let projectDir: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-pcol-'));
  projectDir = join(sandbox, 'project');
  await mkdir(projectDir, { recursive: true });
  process.env.MEMORIZE_ROOT = join(sandbox, '.memorize-home');
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

/**
 * For every projection table that duplicates entity fields into extracted
 * SQL columns, the column value MUST equal the corresponding field inside the
 * row's `data` JSON. Readers split trust (getTask parses `data`; listTasks
 * filters/sorts on the columns); they only agree because one INSERT writes
 * both from the same object. Nothing enforces that — this is the guard.
 */
describe('projection column == data JSON consistency', () => {
  it('every extracted column matches its parsed data field across tables', async () => {
    // Build a representative project state through the public services so the
    // extracted columns are exercised with real, varied values.
    const project = await createProject({ title: 'Cols', rootPath: projectDir });
    const projectId = project.id;
    const workstreamId = project.activeWorkstreamIds[0]!;

    // Tasks with different statuses + a workstream link + an update so
    // created_at and updated_at can diverge.
    await createTask({
      projectId,
      workstreamId,
      title: 'Todo task',
    });
    const doing = await createTask({
      projectId,
      workstreamId,
      title: 'In-progress task',
    });
    await updateTask(projectId, doing.id, { status: 'in_progress' });

    // A session (sessions.status).
    await startSession(projectDir, { actor: 'claude', projectId });

    // A decision (decisions.status) via the domain factory + event, the same
    // public path setup-service uses.
    const decision = createDecision({
      scopeType: 'project',
      scopeId: projectId,
      title: 'Use SQLite',
      decision: 'Adopt SQLite event store',
      rationale: 'Single-file durability',
      createdBy: 'test',
    });
    await appendEvent({
      type: 'decision.proposed',
      projectId,
      scopeType: 'project',
      scopeId: projectId,
      actor: 'test',
      payload: decision,
    });

    // A rule (rules.source).
    const rule = createRule({
      scopeType: 'project',
      scopeId: projectId,
      title: 'Imported rule',
      body: 'Keep commits small',
      updatedBy: 'test',
      source: 'imported',
    });
    await appendEvent({
      type: 'rule.upserted',
      projectId,
      scopeType: 'project',
      scopeId: projectId,
      actor: 'test',
      payload: rule,
    });

    // A conflict (conflicts.status).
    const conflict = createConflict({
      projectId,
      scopeType: 'rule',
      scopeId: projectId,
      fieldPath: 'commit_style',
      leftVersion: 'small_commits',
      rightVersion: 'squash_final_commit',
      conflictType: 'rule',
    });
    await appendEvent({
      type: 'conflict.detected',
      projectId,
      scopeType: 'project',
      scopeId: projectId,
      actor: 'test',
      payload: conflict,
    });

    await rebuildProjectProjection(projectId);

    // table → (extracted column → field path inside parsed `data`).
    const tableColumns: Record<string, Record<string, string>> = {
      workstreams: { status: 'status' },
      tasks: {
        status: 'status',
        workstream_id: 'workstreamId',
        created_at: 'createdAt',
        updated_at: 'updatedAt',
      },
      decisions: { status: 'status' },
      rules: { source: 'source' },
      conflicts: { status: 'status' },
      sessions: { status: 'status' },
    };

    const db = getDb(projectId);
    for (const [table, columns] of Object.entries(tableColumns)) {
      const colNames = Object.keys(columns);
      const rows = db
        .prepare(`SELECT ${colNames.join(', ')}, data FROM ${table}`)
        .all() as Array<Record<string, unknown> & { data: string }>;

      // Each table must contribute at least one row, otherwise the assertion
      // below vacuously passes and the test guards nothing.
      expect(rows.length, `${table} should have rows`).toBeGreaterThan(0);

      for (const row of rows) {
        const data = JSON.parse(row.data) as Record<string, unknown>;
        for (const [column, field] of Object.entries(columns)) {
          // null column ⇔ undefined field (the projection writes `?? null`).
          const columnValue = row[column] ?? undefined;
          expect(
            columnValue,
            `${table}.${column} must equal data.${field}`,
          ).toBe(data[field]);
        }
      }
    }
  });
});
