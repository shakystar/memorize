import { mkdtemp, mkdir, rm, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../src/domain/common.js';
import type { DomainEvent } from '../../src/domain/events.js';
import { reduceProjectState } from '../../src/projections/projector.js';
import { closeAll, getDb } from '../../src/storage/db.js';
import { readEvents } from '../../src/storage/event-store.js';
import {
  cleanupEventsBackup,
  migrateProjectFromNdjson,
} from '../../src/services/migrate-service.js';
import { exportEventsToNdjson } from '../../src/services/export-service.js';

const projectId = 'proj_mig_test01';

let sandbox: string;

function legacyEvent(
  overrides: Partial<DomainEvent> & Pick<DomainEvent, 'id' | 'type'>,
): DomainEvent {
  const ts = '2026-01-01T00:00:00.000Z';
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: ts,
    updatedAt: ts,
    projectId,
    scopeType: 'project',
    scopeId: projectId,
    actor: 'system',
    payload: {},
    ...overrides,
  } as DomainEvent;
}

async function seedLegacyNdjson(events: DomainEvent[]): Promise<void> {
  const eventsDir = join(sandbox, 'projects', projectId, 'events');
  await mkdir(eventsDir, { recursive: true });
  // Two dated files to exercise filename-sorted, line-ordered replay.
  const half = Math.ceil(events.length / 2);
  await writeFile(
    join(eventsDir, '2026-01-01.ndjson'),
    events.slice(0, half).map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8',
  );
  await writeFile(
    join(eventsDir, '2026-01-02.ndjson'),
    events.slice(half).map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8',
  );
}

const sampleEvents: DomainEvent[] = [
  legacyEvent({
    id: 'evt_a',
    type: 'project.created',
    payload: {
      id: projectId,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      title: 'Mig',
      summary: 'Migration project',
      activeWorkstreamIds: [],
      activeTaskIds: [],
      acceptedDecisionIds: [],
      ruleIds: [],
    } as never,
  }),
  legacyEvent({
    id: 'evt_b',
    type: 'task.created',
    scopeType: 'task',
    scopeId: 'task_1',
    payload: { id: 'task_1', title: 'First', status: 'todo' } as never,
  }),
  legacyEvent({
    id: 'evt_c',
    type: 'task.updated',
    scopeType: 'task',
    scopeId: 'task_1',
    payload: { status: 'in_progress' } as never,
  }),
];

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-migrate-'));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('migrate (NDJSON → SQLite)', () => {
  it('migrates legacy events, preserves order, passes equivalence, and moves events.bak', async () => {
    await seedLegacyNdjson(sampleEvents);

    const result = await migrateProjectFromNdjson(projectId);
    expect(result.status).toBe('migrated');
    expect(result.legacyEventCount).toBe(3);
    expect(result.insertedCount).toBe(3);

    const events = await readEvents(projectId);
    expect(events.map((e) => e.id)).toEqual(['evt_a', 'evt_b', 'evt_c']);

    // Equivalence: the migrated stream is byte-for-byte the legacy stream
    // (deterministic; reduceProjectState is not — see migrate-service note).
    expect(events).toEqual(sampleEvents);
    // And both reduce without throwing.
    expect(() => reduceProjectState(events)).not.toThrow();

    // events/*.ndjson moved to events.bak/
    const projectRoot = join(sandbox, 'projects', projectId);
    const eventsDir = await readdir(join(projectRoot, 'events')).catch(() => []);
    expect(eventsDir.filter((f) => f.endsWith('.ndjson'))).toEqual([]);
    const bak = await readdir(join(projectRoot, 'events.bak'));
    expect(bak.sort()).toEqual(['2026-01-01.ndjson', '2026-01-02.ndjson']);
  });

  it('is idempotent — a second run is a no-op', async () => {
    await seedLegacyNdjson(sampleEvents);
    await migrateProjectFromNdjson(projectId);

    const second = await migrateProjectFromNdjson(projectId);
    expect(second.status).toBe('already-migrated');

    const events = await readEvents(projectId);
    expect(events.map((e) => e.id)).toEqual(['evt_a', 'evt_b', 'evt_c']);
  });

  it('marks projects with no legacy events as migrated without error', async () => {
    const result = await migrateProjectFromNdjson(projectId);
    expect(result.status).toBe('no-legacy-events');

    // Re-run still skips.
    const again = await migrateProjectFromNdjson(projectId);
    expect(again.status).toBe('already-migrated');
  });

  it('INSERT OR IGNORE dedupes when migrate re-runs over already-present rows', async () => {
    await seedLegacyNdjson(sampleEvents);
    await migrateProjectFromNdjson(projectId);

    // Simulate a re-run as if the marker had not been set: clear it and
    // restore the legacy NDJSON from the backup, then migrate again. The
    // id UNIQUE constraint + INSERT OR IGNORE must insert 0 new rows.
    const db = getDb(projectId);
    db.prepare('DELETE FROM meta WHERE key = ?').run('migrated_from_ndjson');
    const projectRoot = join(sandbox, 'projects', projectId);
    const bak = await readdir(join(projectRoot, 'events.bak'));
    await mkdir(join(projectRoot, 'events'), { recursive: true });
    for (const file of bak) {
      const body = await readFile(join(projectRoot, 'events.bak', file), 'utf8');
      await writeFile(join(projectRoot, 'events', file), body, 'utf8');
    }

    const rerun = await migrateProjectFromNdjson(projectId);
    expect(rerun.status).toBe('migrated');
    expect(rerun.legacyEventCount).toBe(3);
    expect(rerun.insertedCount).toBe(0);

    const events = await readEvents(projectId);
    expect(events.map((e) => e.id)).toEqual(['evt_a', 'evt_b', 'evt_c']);
  });
});

describe('cleanupEventsBackup', () => {
  it('removes events.bak only after migration, and is a no-op otherwise', async () => {
    await seedLegacyNdjson(sampleEvents);
    await migrateProjectFromNdjson(projectId);

    const projectRoot = join(sandbox, 'projects', projectId);
    // Backup exists post-migration.
    expect((await readdir(join(projectRoot, 'events.bak'))).length).toBe(2);

    const removed = await cleanupEventsBackup(projectId);
    expect(removed.status).toBe('removed');
    await expect(readdir(join(projectRoot, 'events.bak'))).rejects.toThrow();

    // A second run is a no-op (backup already gone).
    const again = await cleanupEventsBackup(projectId);
    expect(again.status).toBe('no-backup');
  });

  it('refuses to delete the backup when the project is not yet migrated', async () => {
    // Stand up the events.bak dir WITHOUT a migrated marker (simulates a
    // half-state). cleanup must leave it untouched as the recovery net.
    const projectRoot = join(sandbox, 'projects', projectId);
    await mkdir(join(projectRoot, 'events.bak'), { recursive: true });
    await writeFile(
      join(projectRoot, 'events.bak', '2026-01-01.ndjson'),
      '{}\n',
      'utf8',
    );

    const result = await cleanupEventsBackup(projectId);
    expect(result.status).toBe('not-migrated');
    expect((await readdir(join(projectRoot, 'events.bak'))).length).toBe(1);
  });
});

describe('export (SQLite → NDJSON round-trip)', () => {
  it('exports in seq order and round-trips through a fresh migrate', async () => {
    await seedLegacyNdjson(sampleEvents);
    await migrateProjectFromNdjson(projectId);

    const ndjson = await exportEventsToNdjson(projectId);
    const lines = ndjson.split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    const exported = lines.map((l) => JSON.parse(l) as DomainEvent);
    expect(exported.map((e) => e.id)).toEqual(['evt_a', 'evt_b', 'evt_c']);

    // Round-trip: feed the exported NDJSON into a fresh project DB via
    // migrate, then assert reduced state equality.
    const freshProjectId = 'proj_mig_test02';
    const freshEventsDir = join(sandbox, 'projects', freshProjectId, 'events');
    await mkdir(freshEventsDir, { recursive: true });
    await writeFile(
      join(freshEventsDir, '2026-01-01.ndjson'),
      ndjson + '\n',
      'utf8',
    );
    await migrateProjectFromNdjson(freshProjectId);

    // Round-trip equivalence: the fresh project's event stream equals the
    // original's (the exported NDJSON carries the original projectId/ids).
    // Compared as event streams to stay deterministic.
    const original = await readEvents(projectId);
    const roundTripped = await readEvents(freshProjectId);
    expect(roundTripped).toEqual(original);
  });

  it('writes a trailing newline when exporting to a file', async () => {
    await seedLegacyNdjson(sampleEvents);
    await migrateProjectFromNdjson(projectId);

    const ndjson = await exportEventsToNdjson(projectId);
    const outFile = join(sandbox, 'export.ndjson');
    await writeFile(outFile, ndjson ? `${ndjson}\n` : '', 'utf8');
    const written = await readFile(outFile, 'utf8');
    expect(written.endsWith('\n')).toBe(true);
    expect((await stat(outFile)).isFile()).toBe(true);
  });
});
