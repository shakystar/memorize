import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../src/domain/common.js';
import { doctor } from '../../src/services/repair-service.js';
import {
  createProject,
  ensureProjectGenesis,
} from '../../src/services/project-service.js';
import { getProjectProjection } from '../../src/services/projection-store.js';
import { bindProject } from '../../src/storage/bindings-store.js';
import { closeAll, getDb } from '../../src/storage/db.js';

const PROJECT_ID = 'proj_genesis_test';

let sandbox: string;
let memorizeRoot: string;
let projectDir: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-genesis-'));
  memorizeRoot = join(sandbox, '.memorize-home');
  projectDir = join(sandbox, 'project');
  await mkdir(projectDir, { recursive: true });
  process.env.MEMORIZE_ROOT = memorizeRoot;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

/**
 * Seed observation events directly with NO project.created — reproduces the
 * migration / capture-without-genesis failure mode this backfill repairs.
 */
function seedObservations(projectId: string, tsList: string[]): void {
  const db = getDb(projectId);
  tsList.forEach((ts, i) => {
    db.prepare(
      `INSERT INTO events
         (id, schema_version, created_at, updated_at, type,
          project_id, scope_type, scope_id, actor,
          writer, source_project_id, payload)
       VALUES (?, 1, ?, ?, 'observation.captured', ?, 'session', ?, 'claude',
               'claude', ?, '{}')`,
    ).run(`evt_obs_${i}`, ts, ts, projectId, 'session_x', projectId);
  });
}

/**
 * Seed a REAL project.created directly (with distinctive metadata) but do NOT
 * build the projection — reproduces the dropped-tables / interrupted-migration
 * case where the genesis is present in the log yet the projection is unbuilt.
 */
function seedGenesis(
  projectId: string,
  ts: string,
  overrides: { title: string; summary: string; goals: string[] },
): void {
  const db = getDb(projectId);
  const payload = {
    id: projectId,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: ts,
    updatedAt: ts,
    title: overrides.title,
    summary: overrides.summary,
    goals: overrides.goals,
    status: 'active',
    rootPath: '',
    importedContextCount: 0,
    activeWorkstreamIds: [],
    activeTaskIds: [],
    acceptedDecisionIds: [],
    ruleIds: [],
  };
  db.prepare(
    `INSERT INTO events
       (id, schema_version, created_at, updated_at, type,
        project_id, scope_type, scope_id, actor,
        writer, source_project_id, payload)
     VALUES (?, 1, ?, ?, 'project.created', ?, 'project', ?, 'claude',
             'claude', ?, ?)`,
  ).run(
    'evt_genesis',
    ts,
    ts,
    projectId,
    projectId,
    projectId,
    JSON.stringify(payload),
  );
}

describe('ensureProjectGenesis — genesis backfill', () => {
  it('rebuilds from an existing genesis instead of clobbering it with synthetic defaults', async () => {
    await bindProject(projectDir, PROJECT_ID);
    // A real genesis is in the log, but the projection was never built.
    seedGenesis(PROJECT_ID, '2026-07-01T11:33:45.000Z', {
      title: 'Real Title Preserved',
      summary: 'Real summary that must survive',
      goals: ['keep this goal'],
    });
    expect(getProjectProjection(PROJECT_ID)).toBeUndefined();

    await ensureProjectGenesis(PROJECT_ID);

    // The projection is recovered from the existing genesis — NOT overwritten
    // by a second synthetic project.created whose reconstructed defaults
    // (basename title, empty goals/summary) would win under later-wins.
    const project = getProjectProjection(PROJECT_ID);
    expect(project?.title).toBe('Real Title Preserved');
    expect(project?.summary).toBe('Real summary that must survive');
    expect(project?.goals).toEqual(['keep this goal']);
  });


  it('backfills project.created when events exist but genesis is missing, dated at the earliest event', async () => {
    await bindProject(projectDir, PROJECT_ID);
    seedObservations(PROJECT_ID, [
      '2026-07-01T11:33:45.000Z',
      '2026-07-01T12:00:00.000Z',
    ]);

    // Genesis missing → no projection row yet.
    expect(getProjectProjection(PROJECT_ID)).toBeUndefined();

    const didBackfill = await ensureProjectGenesis(PROJECT_ID);
    expect(didBackfill).toBe(true);

    const project = getProjectProjection(PROJECT_ID);
    expect(project).toBeDefined();
    // Dated at the store's earliest event, not repair time.
    expect(project?.createdAt).toBe('2026-07-01T11:33:45.000Z');
    // rootPath/title recovered from the binding.
    expect(project?.rootPath).toBe(path.resolve(projectDir));
    expect(project?.title).toBe('project');
  });

  it('is a no-op on an empty log (nothing to recover)', async () => {
    await bindProject(projectDir, PROJECT_ID);
    // Touch the db so it exists but has zero events.
    getDb(PROJECT_ID);

    const didBackfill = await ensureProjectGenesis(PROJECT_ID);
    expect(didBackfill).toBe(false);
    expect(getProjectProjection(PROJECT_ID)).toBeUndefined();
  });

  it('is a no-op when a genesis already exists (idempotent)', async () => {
    const project = await createProject({
      title: 'Healthy',
      rootPath: projectDir,
    });
    const didBackfill = await ensureProjectGenesis(project.id);
    expect(didBackfill).toBe(false);
  });

  it('doctor flags a non-empty log with no project.created genesis as error', async () => {
    await bindProject(projectDir, PROJECT_ID);
    seedObservations(PROJECT_ID, ['2026-07-01T11:33:45.000Z']);

    const report = await doctor(projectDir);
    const check = report.checks.find((c) => c.id === 'projection.built');
    expect(check?.status).toBe('error');
    expect(check?.message).toMatch(/genesis/i);
  });
});
