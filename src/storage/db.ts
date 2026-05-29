import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { getProjectDbFile } from './path-resolver.js';

/**
 * Ordered DDL migrations applied via `PRAGMA user_version`. The user_version
 * tracks table DDL only; it is ORTHOGONAL to per-row `event.schemaVersion`
 * (which versions payload shape, not table structure). Append future
 * migrations to this array — never reorder or mutate existing entries.
 */
const MIGRATIONS: ReadonlyArray<(db: Database.Database) => void> = [
  // v1 — events table + indexes (Phase 0: created but not yet written to).
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq            INTEGER PRIMARY KEY,
        id             TEXT NOT NULL UNIQUE,
        schema_version INTEGER NOT NULL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        type           TEXT NOT NULL,
        project_id     TEXT NOT NULL,
        scope_type     TEXT NOT NULL,
        scope_id       TEXT NOT NULL,
        actor          TEXT NOT NULL,
        payload        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_type  ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_scope ON events(scope_type, scope_id);
    `);
  },
  // v2 — key/value meta table (Phase 1: holds the ndjson migration marker).
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  },
  // v3 — projection tables (Phase 2). Each row stores the full entity in a
  // `data` JSON column; extra columns exist only where a reader queries or
  // sorts by them. `project` and `memory_index` are per-db singletons (one
  // row, id = projectId). reduceProjectState remains the single reduction
  // authority — these tables are a persistence sink, not a parallel reducer.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id   TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_index (
        id   TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workstreams (
        id     TEXT PRIMARY KEY,
        status TEXT,
        data   TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id            TEXT PRIMARY KEY,
        status        TEXT,
        workstream_id TEXT,
        created_at    TEXT,
        updated_at    TEXT,
        data          TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS handoffs (
        id   TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        id   TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS decisions (
        id     TEXT PRIMARY KEY,
        status TEXT,
        data   TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rules (
        id     TEXT PRIMARY KEY,
        source TEXT,
        data   TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conflicts (
        id     TEXT PRIMARY KEY,
        status TEXT,
        data   TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id     TEXT PRIMARY KEY,
        status TEXT,
        data   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status  ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_conflicts_status ON conflicts(status);
      CREATE INDEX IF NOT EXISTS idx_sessions_status  ON sessions(status);
    `);
  },
  // v4 — FTS5 full-text search index (Phase 3). Standalone (NOT
  // external-content) virtual table: `text` is the only indexed column;
  // `entity_id` and `kind` ride along UNINDEXED for retrieval/display.
  // `kind` ∈ {task, handoff, decision, checkpoint, topic}. Populated as a
  // replace-all sink inside rebuildProjectProjection's transaction — never
  // written through a second path. If the bundled SQLite lacks FTS5 this
  // CREATE throws and the migration fails loudly (no silent fallback).
  (db) => {
    db.exec(`
      CREATE VIRTUAL TABLE search_fts USING fts5(
        entity_id UNINDEXED,
        kind UNINDEXED,
        text,
        tokenize='unicode61'
      );
    `);
  },
  // v5 — correct events.schema_version column type from INTEGER to TEXT. The
  // stored value is the semver STRING `CURRENT_SCHEMA_VERSION` (e.g. '0.1.0');
  // INTEGER affinity stored it as text losslessly today, but a future numeric
  // comparison/sort would mis-order it. SQLite can't ALTER a column type, so
  // rebuild the table: copy every row in seq order into an identically-shaped
  // table with `schema_version TEXT`, swap, then recreate the two indexes.
  (db) => {
    db.exec(`
      CREATE TABLE events_new (
        seq            INTEGER PRIMARY KEY,
        id             TEXT NOT NULL UNIQUE,
        schema_version TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        type           TEXT NOT NULL,
        project_id     TEXT NOT NULL,
        scope_type     TEXT NOT NULL,
        scope_id       TEXT NOT NULL,
        actor          TEXT NOT NULL,
        payload        TEXT NOT NULL
      );
      INSERT INTO events_new
        (seq, id, schema_version, created_at, updated_at, type,
         project_id, scope_type, scope_id, actor, payload)
      SELECT
        seq, id, schema_version, created_at, updated_at, type,
        project_id, scope_type, scope_id, actor, payload
      FROM events;
      DROP TABLE events;
      ALTER TABLE events_new RENAME TO events;
      CREATE INDEX IF NOT EXISTS idx_events_type  ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_scope ON events(scope_type, scope_id);
    `);
  },
];

function runMigrations(db: Database.Database): void {
  // Acquire a write lock up front (BEGIN IMMEDIATE) and re-read user_version
  // INSIDE it. When two fresh processes open the same new DB at once, the
  // first runs the migrations and bumps user_version; the second blocks on
  // busy_timeout, then — now inside the lock — re-reads the bumped version and
  // runs nothing. Without the immediate lock both processes read version 0 up
  // front and the second re-runs the v4 `CREATE VIRTUAL TABLE search_fts`
  // (which lacks IF NOT EXISTS), throwing "table search_fts already exists".
  const runAll = db.transaction(() => {
    const current = db.pragma('user_version', { simple: true }) as number;
    for (let version = current; version < MIGRATIONS.length; version++) {
      const migrate = MIGRATIONS[version]!;
      migrate(db);
      // user_version is the count of applied migrations.
      db.pragma(`user_version = ${version + 1}`);
    }
  });
  runAll.immediate();
}

/**
 * Switch to WAL, retrying on SQLITE_BUSY. `PRAGMA journal_mode = WAL` takes a
 * brief exclusive lock and — unlike ordinary statements — does NOT honor
 * `busy_timeout`: it returns "database is locked" immediately if another
 * connection holds any lock. On a fresh DB opened by several processes at once
 * that is a real (if rare) collision, so we retry with a short backoff. The
 * busy window is the WAL switch + first migration of one process, well under
 * the total budget here.
 */
function enableWalWithRetry(db: Database.Database): void {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      db.pragma('journal_mode = WAL');
      return;
    } catch (error) {
      const busy =
        error instanceof Error && /database is locked|SQLITE_BUSY/.test(error.message);
      if (!busy || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

function open(dbFile: string): Database.Database {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new Database(dbFile);
  // Set busy_timeout first so ordinary statements + the IMMEDIATE migration
  // lock wait rather than error; the WAL switch needs its own retry (above).
  db.pragma('busy_timeout = 5000');
  enableWalWithRetry(db);
  runMigrations(db);
  return db;
}

const connections = new Map<string, Database.Database>();

/** Lazily open and cache one connection per projectId for this process. */
export function getDb(projectId: string): Database.Database {
  const cached = connections.get(projectId);
  if (cached) return cached;
  const db = open(getProjectDbFile(projectId));
  connections.set(projectId, db);
  return db;
}

/** Close all cached connections (WAL auto-checkpoints on close). */
export function closeAll(): void {
  for (const db of connections.values()) {
    db.close();
  }
  connections.clear();
}

/**
 * Open an arbitrary db path (uncached) with the same pragmas + migrations.
 * Intended for tests; the per-project `getDb` API is the main surface.
 */
export function openDbAt(dbFile: string): Database.Database {
  return open(dbFile);
}

process.once('exit', closeAll);
