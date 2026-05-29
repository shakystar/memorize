import path from 'node:path';

import type Database from 'better-sqlite3';

import { createId, CURRENT_SCHEMA_VERSION, nowIso } from '../domain/common.js';
import type {
  DomainEvent,
  DomainEventPayload,
  DomainEventType,
} from '../domain/events.js';
import { getDb } from './db.js';
import { ensureDir } from './fs-utils.js';
import { getProjectRoot } from './path-resolver.js';

export interface AppendEventInput<TPayload extends DomainEventPayload> {
  type: DomainEventType;
  projectId: string;
  scopeType: DomainEvent['scopeType'];
  scopeId: string;
  actor: string;
  payload: TPayload;
}

export async function ensureProjectDirectories(projectId: string): Promise<void> {
  const projectRoot = getProjectRoot(projectId);
  // Events and the entity projections (tasks, workstreams, rules, …) now live
  // in SQLite, so their old JSON dirs are no longer created. Only the dirs
  // still written to disk remain: `topics/` (topic `.md` files) and `sync/`
  // (remote/inbound staging).
  await Promise.all(
    [
      projectRoot,
      path.join(projectRoot, 'topics'),
      path.join(projectRoot, 'sync'),
    ].map((dirPath) => ensureDir(dirPath)),
  );
}

/** Map a DomainEvent onto the `events` table columns. payload is JSON text. */
function insertEvent(db: Database.Database, event: DomainEvent): void {
  db.prepare(
    `INSERT INTO events
       (id, schema_version, created_at, updated_at, type,
        project_id, scope_type, scope_id, actor, payload)
     VALUES
       (@id, @schemaVersion, @createdAt, @updatedAt, @type,
        @projectId, @scopeType, @scopeId, @actor, @payload)`,
  ).run({
    id: event.id,
    schemaVersion: event.schemaVersion,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    type: event.type,
    projectId: event.projectId,
    scopeType: event.scopeType,
    scopeId: event.scopeId,
    actor: event.actor,
    payload: JSON.stringify(event.payload),
  });
}

export async function appendEvent<TPayload extends DomainEventPayload>(
  input: AppendEventInput<TPayload>,
): Promise<DomainEvent<TPayload>> {
  const timestamp = nowIso();
  const event: DomainEvent<TPayload> = {
    id: createId('evt'),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
    type: input.type,
    projectId: input.projectId,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    actor: input.actor,
    payload: input.payload,
  };

  // better-sqlite3 is synchronous; the async signature is preserved so
  // existing `await appendEvent(...)` call sites stay unchanged.
  insertEvent(getDb(input.projectId), event);
  return event;
}

/**
 * Append several events as ONE atomic unit. All inserts run inside a single
 * `db.transaction(...)` so a throw partway through (e.g. a non-serializable
 * payload) rolls the whole batch back — the append-only log never ends up
 * with a partial logical operation. Insert order = the order of `inputs`,
 * which becomes the `seq` (replay) order.
 *
 * Use this when a single logical operation emits multiple back-to-back
 * events; single-event flows keep using `appendEvent`.
 */
export async function appendEvents<TPayload extends DomainEventPayload>(
  projectId: string,
  inputs: AppendEventInput<TPayload>[],
): Promise<DomainEvent<TPayload>[]> {
  const events: DomainEvent<TPayload>[] = inputs.map((input) => {
    const timestamp = nowIso();
    return {
      id: createId('evt'),
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: timestamp,
      updatedAt: timestamp,
      type: input.type,
      projectId: input.projectId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      actor: input.actor,
      payload: input.payload,
    };
  });

  const db = getDb(projectId);
  db.transaction(() => {
    for (const event of events) {
      insertEvent(db, event);
    }
  })();
  return events;
}

/**
 * Insert externally-sourced events (e.g. pulled from a sync remote) into the
 * `events` table, deduplicating on the `id UNIQUE` constraint via
 * `INSERT OR IGNORE` — the same re-runnable shape migrate-service uses. Runs as
 * ONE transaction, so the batch is all-or-nothing for the structurally-valid
 * events handed in. Returns the number of NEWLY inserted rows (duplicates
 * contribute 0, via better-sqlite3 `info.changes`).
 *
 * Ordering: external events are appended at the tail in arrival order, taking
 * local `seq` values after existing rows. Causal/parent ordering across
 * machines is deferred to #22.
 */
export async function insertExternalEvents(
  projectId: string,
  events: DomainEvent[],
): Promise<number> {
  const db = getDb(projectId);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO events
       (id, schema_version, created_at, updated_at, type,
        project_id, scope_type, scope_id, actor, payload)
     VALUES
       (@id, @schemaVersion, @createdAt, @updatedAt, @type,
        @projectId, @scopeType, @scopeId, @actor, @payload)`,
  );
  const insertAll = db.transaction((rows: DomainEvent[]): number => {
    let inserted = 0;
    for (const event of rows) {
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
        payload: JSON.stringify(event.payload),
      });
      inserted += info.changes;
    }
    return inserted;
  });
  return insertAll(events);
}

interface EventRow {
  id: string;
  schema_version: string;
  created_at: string;
  updated_at: string;
  type: DomainEventType;
  project_id: string;
  scope_type: DomainEvent['scopeType'];
  scope_id: string;
  actor: string;
  payload: string;
}

function rowToEvent(row: EventRow): DomainEvent {
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    type: row.type,
    projectId: row.project_id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    actor: row.actor,
    payload: JSON.parse(row.payload) as unknown,
  };
}

export interface EventIntegrity {
  events: DomainEvent[];
}

export async function readEventsWithIntegrity(
  projectId: string,
): Promise<EventIntegrity> {
  // `seq` (autoincrement primary key) is the deterministic replay order,
  // replacing the old filename + line ordering. SQLite stores whole rows,
  // so there is no partial-line corruption to report. Whole-DB corruption is
  // covered by `PRAGMA integrity_check` in repair-service's doctor.
  const rows = getDb(projectId)
    .prepare('SELECT * FROM events ORDER BY seq')
    .all() as EventRow[];
  return { events: rows.map(rowToEvent) };
}

export async function readEvents(projectId: string): Promise<DomainEvent[]> {
  const { events } = await readEventsWithIntegrity(projectId);
  return events;
}

/**
 * Events strictly after the row whose `id` is `sinceEventId`, in `seq` order.
 * When `sinceEventId` is undefined (or not found in the log) every event is
 * returned — matching the old array-scan semantics of sliceEventsSince.
 */
export async function readEventsSince(
  projectId: string,
  sinceEventId: string | undefined,
): Promise<DomainEvent[]> {
  const db = getDb(projectId);
  if (!sinceEventId) {
    return (db.prepare('SELECT * FROM events ORDER BY seq').all() as EventRow[]).map(
      rowToEvent,
    );
  }
  const watermark = db
    .prepare('SELECT seq FROM events WHERE id = ?')
    .get(sinceEventId) as { seq: number } | undefined;
  if (!watermark) {
    // Unknown watermark — fall back to "everything", as the old findIndex
    // did when the id was not present in the log.
    return (db.prepare('SELECT * FROM events ORDER BY seq').all() as EventRow[]).map(
      rowToEvent,
    );
  }
  const rows = db
    .prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq')
    .all(watermark.seq) as EventRow[];
  return rows.map(rowToEvent);
}
