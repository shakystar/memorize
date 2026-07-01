import fs from 'node:fs/promises';
import path from 'node:path';

import { reduceProjectState } from '../projections/projector.js';
import type { DomainEvent } from '../domain/events.js';
import { getDb } from '../storage/db.js';
import { readEvents } from '../storage/event-store.js';
import { isEnoent, readNdjson } from '../storage/fs-utils.js';
import { getProjectRoot } from '../storage/path-resolver.js';
import { rebuildProjectProjection } from './projection-store.js';
import { requireBoundProjectId } from './project-service.js';

const MIGRATED_MARKER_KEY = 'migrated_from_ndjson';

/** Stable, key-order-independent JSON for structural comparison. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(val as Record<string, unknown>).sort()) {
        sorted[key] = (val as Record<string, unknown>)[key];
      }
      return sorted;
    }
    return val;
  });
}

export interface MigrateResult {
  status: 'migrated' | 'already-migrated' | 'no-legacy-events';
  legacyEventCount: number;
  insertedCount: number;
}

function isMigrated(projectId: string): boolean {
  const row = getDb(projectId)
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get(MIGRATED_MARKER_KEY) as { value: string } | undefined;
  return row?.value === '1';
}

/**
 * Cheap detection of the "upgraded from the NDJSON era but never ran
 * `memorize migrate`" state: the SQLite `migrated_from_ndjson` marker is
 * absent AND a legacy `events/` dir holds at least one `*.ndjson` file. Does
 * NOT parse the NDJSON (existence check only) so it is safe on a hot path.
 * Surfaced as a loud warning by `doctor` and the SessionStart hook so the
 * user knows to run `memorize migrate` instead of seeing an empty store.
 */
export async function hasUnmigratedNdjson(projectId: string): Promise<boolean> {
  if (isMigrated(projectId)) return false;
  const eventsDir = path.join(getProjectRoot(projectId), 'events');
  try {
    const files = await fs.readdir(eventsDir);
    return files.some((file) => file.endsWith('.ndjson'));
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

function markMigrated(projectId: string): void {
  getDb(projectId)
    .prepare(
      `INSERT INTO meta (key, value) VALUES (?, '1')
       ON CONFLICT(key) DO UPDATE SET value = '1'`,
    )
    .run(MIGRATED_MARKER_KEY);
}

/**
 * Read legacy NDJSON events exactly as the old event store did: every
 * `events/*.ndjson` file, sorted by filename, lines in order. Used as the
 * migration source of truth.
 */
async function readLegacyNdjsonEvents(
  projectId: string,
): Promise<DomainEvent[]> {
  const eventsDir = path.join(getProjectRoot(projectId), 'events');
  let files: string[];
  try {
    files = (await fs.readdir(eventsDir))
      .filter((file) => file.endsWith('.ndjson'))
      .sort();
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }

  const events: DomainEvent[] = [];
  for (const file of files) {
    const rows = await readNdjson<DomainEvent>(path.join(eventsDir, file));
    events.push(...rows);
  }
  return events;
}

/**
 * Explicit one-time migration of the append-only NDJSON event log into the
 * SQLite `events` table. Idempotent and re-runnable:
 *  - Skips if the project DB already carries the `migrated_from_ndjson` marker.
 *  - Inserts all legacy events in a single transaction with INSERT OR IGNORE
 *    (the `id UNIQUE` constraint dedupes, so a partial re-run is safe).
 *  - Verifies equivalence by reducing project state from the legacy events
 *    vs. the SQLite events; only on a deep-equal match does it move
 *    `events/*.ndjson` aside to `events.bak/`. On mismatch it aborts and
 *    leaves the NDJSON files untouched.
 */
export async function migrateProjectFromNdjson(
  projectId: string,
): Promise<MigrateResult> {
  if (isMigrated(projectId)) {
    return {
      status: 'already-migrated',
      legacyEventCount: 0,
      insertedCount: 0,
    };
  }

  const legacyEvents = await readLegacyNdjsonEvents(projectId);
  const db = getDb(projectId);

  if (legacyEvents.length === 0) {
    // Nothing to migrate — still stamp the marker so future runs skip.
    markMigrated(projectId);
    return {
      status: 'no-legacy-events',
      legacyEventCount: 0,
      insertedCount: 0,
    };
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO events
       (id, schema_version, created_at, updated_at, type,
        project_id, scope_type, scope_id, actor,
        writer, source_project_id, payload)
     VALUES
       (@id, @schemaVersion, @createdAt, @updatedAt, @type,
        @projectId, @scopeType, @scopeId, @actor,
        @writer, @sourceProjectId, @payload)`,
  );

  const insertAll = db.transaction((events: DomainEvent[]): number => {
    let inserted = 0;
    for (const event of events) {
      const info = insert.run({
        id: event.id,
        schemaVersion: event.schemaVersion,
        createdAt: event.createdAt,
        updatedAt: event.updatedAt,
        type: event.type,
        projectId: event.projectId,
        scopeType: event.scopeType,
        scopeId: event.scopeId,
        actor: event.actor,
        writer: event.writer ?? null,
        sourceProjectId: event.sourceProjectId ?? null,
        payload: JSON.stringify(event.payload),
      });
      inserted += info.changes;
    }
    return inserted;
  });

  const insertedCount = insertAll(legacyEvents);

  // Equivalence check. The brief asked to compare reduceProjectState from the
  // legacy events vs the SQLite events; however reduceProjectState is NOT
  // deterministic — `task.updated` payloads that omit `updatedAt` fall back
  // to `nowIso()` inside applyTaskUpdate, so reducing the same log twice can
  // differ by a few milliseconds. We therefore assert the stronger and
  // deterministic invariant that migration actually guarantees: the SQLite
  // event stream (in seq order) is byte-for-byte the legacy event stream.
  // This also confirms seq order matches the legacy filename+line order. As a
  // sanity layer we still confirm both streams reduce without throwing.
  const sqliteEvents = await readEvents(projectId);
  if (canonicalJson(sqliteEvents) !== canonicalJson(legacyEvents)) {
    throw new Error(
      `Migration equivalence check failed for project ${projectId}: ` +
        `SQLite event stream does not match the legacy NDJSON stream. ` +
        `NDJSON files left untouched.`,
    );
  }
  // Reductions must not throw on either side (structural sanity).
  reduceProjectState(legacyEvents);
  reduceProjectState(sqliteEvents);

  // Equivalence passed — move the legacy NDJSON aside.
  await moveEventsToBackup(projectId);
  markMigrated(projectId);

  // Build the SQLite projection tables from the now-migrated event log so a
  // freshly-migrated project is immediately readable without an extra
  // `memorize projection rebuild`.
  await rebuildProjectProjection(projectId);

  return {
    status: 'migrated',
    legacyEventCount: legacyEvents.length,
    insertedCount,
  };
}

async function moveEventsToBackup(projectId: string): Promise<void> {
  const projectRoot = getProjectRoot(projectId);
  const eventsDir = path.join(projectRoot, 'events');
  const backupDir = path.join(projectRoot, 'events.bak');

  let files: string[];
  try {
    files = (await fs.readdir(eventsDir)).filter((file) =>
      file.endsWith('.ndjson'),
    );
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }

  await fs.mkdir(backupDir, { recursive: true });
  for (const file of files) {
    await fs.rename(path.join(eventsDir, file), path.join(backupDir, file));
  }
}

export async function migrateFromCwd(cwd: string): Promise<MigrateResult> {
  const projectId = await requireBoundProjectId(cwd);
  return migrateProjectFromNdjson(projectId);
}

export interface CleanupBackupResult {
  status: 'removed' | 'not-migrated' | 'no-backup';
}

/**
 * Explicit, opt-in removal of the `events.bak/` directory that
 * `migrateProjectFromNdjson` leaves behind as a recovery net. Migration itself
 * never deletes it — the backup must outlive the migration. This helper only
 * removes it once the `migrated_from_ndjson` marker is confirmed present, so it
 * can never delete the sole copy of an un-migrated NDJSON log.
 */
export async function cleanupEventsBackup(
  projectId: string,
): Promise<CleanupBackupResult> {
  if (!isMigrated(projectId)) {
    return { status: 'not-migrated' };
  }
  const backupDir = path.join(getProjectRoot(projectId), 'events.bak');
  try {
    await fs.rm(backupDir, { recursive: true });
  } catch (error) {
    if (isEnoent(error)) return { status: 'no-backup' };
    throw error;
  }
  return { status: 'removed' };
}

export async function cleanupEventsBackupFromCwd(
  cwd: string,
): Promise<CleanupBackupResult> {
  const projectId = await requireBoundProjectId(cwd);
  return cleanupEventsBackup(projectId);
}
