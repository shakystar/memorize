import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../src/domain/common.js';
import type { DomainEvent } from '../../src/domain/events.js';
import { doctor } from '../../src/services/repair-service.js';
import { exportFromCwd } from '../../src/services/export-service.js';
import { migrateFromCwd } from '../../src/services/migrate-service.js';
import { createProject } from '../../src/services/project-service.js';
import { bindProject } from '../../src/storage/bindings-store.js';
import { closeAll, getDb } from '../../src/storage/db.js';
import { readEvents } from '../../src/storage/event-store.js';

const LEGACY_PROJECT_ID = 'proj_legacy_001';

let sandbox: string;
let memorizeRoot: string;
let projectDir: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-mig-doctor-'));
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

describe('migrate / export / doctor over SQLite', () => {
  it('migrate from cwd ingests legacy NDJSON and export from cwd round-trips', async () => {
    // A legacy project: NDJSON event log on disk, empty SQLite events table.
    // Bind the cwd to it so migrateFromCwd / exportFromCwd can resolve it.
    await bindProject(projectDir, LEGACY_PROJECT_ID);
    const projectId = LEGACY_PROJECT_ID;

    const ts = '2026-01-01T00:00:00.000Z';
    const events0: DomainEvent[] = [
      {
        id: 'evt_legacy_0',
        schemaVersion: CURRENT_SCHEMA_VERSION,
        createdAt: ts,
        updatedAt: ts,
        type: 'project.created',
        projectId,
        scopeType: 'project',
        scopeId: projectId,
        actor: 'system',
        payload: {
          id: projectId,
          schemaVersion: CURRENT_SCHEMA_VERSION,
          createdAt: ts,
          updatedAt: ts,
          title: 'Legacy',
          summary: 'Legacy project',
          activeWorkstreamIds: [],
          activeTaskIds: [],
          acceptedDecisionIds: [],
          ruleIds: [],
        } as never,
      },
      {
        id: 'evt_legacy_1',
        schemaVersion: CURRENT_SCHEMA_VERSION,
        createdAt: ts,
        updatedAt: ts,
        type: 'rule.upserted',
        projectId,
        scopeType: 'project',
        scopeId: projectId,
        actor: 'system',
        payload: { id: 'rule_1', title: 'Legacy rule', source: 'imported' } as never,
      },
    ];
    const eventsDir = join(memorizeRoot, 'projects', projectId, 'events');
    await mkdir(eventsDir, { recursive: true });
    await writeFile(
      join(eventsDir, '2026-01-01.ndjson'),
      events0.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8',
    );

    const result = await migrateFromCwd(projectDir);
    expect(result.status).toBe('migrated');
    expect(result.insertedCount).toBe(2);

    const events = await readEvents(projectId);
    expect(events.some((e) => e.id === 'evt_legacy_1')).toBe(true);

    // events.bak created.
    const bak = await readdir(
      join(memorizeRoot, 'projects', projectId, 'events.bak'),
    );
    expect(bak).toContain('2026-01-01.ndjson');

    // export to a file.
    const outFile = join(sandbox, 'out.ndjson');
    const exported = await exportFromCwd(projectDir, outFile);
    expect(exported.eventCount).toBe(events.length);
    const written = await readFile(outFile, 'utf8');
    const exportedEvents = written
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as DomainEvent);
    expect(exportedEvents.map((e) => e.id)).toEqual(events.map((e) => e.id));
  });

  it('doctor warns about un-migrated legacy NDJSON, and the warning clears after migrate', async () => {
    await bindProject(projectDir, LEGACY_PROJECT_ID);
    const projectId = LEGACY_PROJECT_ID;

    const ts = '2026-01-01T00:00:00.000Z';
    const events0: DomainEvent[] = [
      {
        id: 'evt_legacy_0',
        schemaVersion: CURRENT_SCHEMA_VERSION,
        createdAt: ts,
        updatedAt: ts,
        type: 'project.created',
        projectId,
        scopeType: 'project',
        scopeId: projectId,
        actor: 'system',
        payload: {
          id: projectId,
          schemaVersion: CURRENT_SCHEMA_VERSION,
          createdAt: ts,
          updatedAt: ts,
          title: 'Legacy',
          summary: 'Legacy project',
          activeWorkstreamIds: [],
          activeTaskIds: [],
          acceptedDecisionIds: [],
          ruleIds: [],
        } as never,
      },
    ];
    const eventsDir = join(memorizeRoot, 'projects', projectId, 'events');
    await mkdir(eventsDir, { recursive: true });
    await writeFile(
      join(eventsDir, '2026-01-01.ndjson'),
      events0.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8',
    );

    // Legacy NDJSON present, no migration marker → doctor warns.
    const before = await doctor(projectDir);
    const ndjsonBefore = before.checks.find((c) => c.id === 'migrate.ndjson');
    expect(ndjsonBefore?.status).toBe('warn');
    expect(ndjsonBefore?.message).toMatch(/memorize migrate/);
    expect(ndjsonBefore?.fix).toBe('memorize migrate');

    await migrateFromCwd(projectDir);

    // After migrate the marker is set → the warning is gone.
    const after = await doctor(projectDir);
    expect(after.checks.find((c) => c.id === 'migrate.ndjson')).toBeUndefined();
  });

  it('doctor reports SQLite integrity as ok for a healthy project DB', async () => {
    await createProject({ title: 'Healthy', rootPath: projectDir });

    const report = await doctor(projectDir);
    const integrity = report.checks.find((c) => c.id === 'db.integrity');
    expect(integrity?.status).toBe('ok');
  });

  it('doctor reports event-log integrity ok for a contiguous seq', async () => {
    await createProject({ title: 'Contiguous', rootPath: projectDir });

    const report = await doctor(projectDir);
    const integrity = report.checks.find((c) => c.id === 'events.integrity');
    expect(integrity?.status).toBe('ok');
  });

  it('doctor flags an event-log seq gap when a middle row is deleted', async () => {
    const project = await createProject({ title: 'Gappy', rootPath: projectDir });
    const db = getDb(project.id);
    // Seed a few more events so seq runs 1..N, then delete a middle row to
    // open a hole in the autoincrement seq (MAX(seq) !== COUNT(*)).
    for (const id of ['evt_a', 'evt_b']) {
      db.prepare(
        `INSERT INTO events
           (id, schema_version, created_at, updated_at, type,
            project_id, scope_type, scope_id, actor, payload)
         VALUES (?, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
                 'rule.upserted', ?, 'project', ?, 'system', '{}')`,
      ).run(id, project.id, project.id);
    }
    db.prepare(
      'DELETE FROM events WHERE seq = (SELECT MAX(seq) - 1 FROM events)',
    ).run();

    const report = await doctor(projectDir);
    const integrity = report.checks.find((c) => c.id === 'events.integrity');
    expect(integrity?.status).toBe('warn');
    expect(integrity?.message).toMatch(/gap/i);
  });
});
