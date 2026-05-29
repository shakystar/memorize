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
];

function runMigrations(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version++) {
    const migrate = MIGRATIONS[version]!;
    db.transaction(() => {
      migrate(db);
      // user_version is the count of applied migrations.
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}

function open(dbFile: string): Database.Database {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
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
