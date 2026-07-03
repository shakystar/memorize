import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { getMemorizeRoot, getProjectDbFile } from './path-resolver.js';

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
      CREATE TABLE IF NOT EXISTS task_requests (
        id                TEXT PRIMARY KEY,
        status            TEXT,
        target_project_id TEXT,
        source_project_id TEXT,
        created_at        TEXT,
        data              TEXT NOT NULL
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
  // v6 — CLS two-layer memory projection tables (Phase 1 spec §2). Both are
  // replace-all sinks of rebuildProjectProjection, derived from
  // `observation.captured` / `memory.consolidated` / `memory.superseded`
  // events — always reconstructable by replay. The mutable columns on
  // `memories` (`invalid_at`, `superseded_by`, `last_accessed_at`) live at
  // the DERIVED projection level only; the events table stays append-only.
  // `last_accessed_at` (retrieval reinforcement) is intentionally
  // best-effort: carried over across routine rebuilds, reset by a true
  // from-scratch replay (decision ⑤, 2026-06-08).
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS observations (
        id         TEXT PRIMARY KEY,
        session_id TEXT,
        signal     TEXT,
        created_at TEXT,
        data       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at);
      CREATE TABLE IF NOT EXISTS memories (
        id               TEXT PRIMARY KEY,
        kind             TEXT,
        salience         INTEGER,
        created_at       TEXT,
        invalid_at       TEXT,
        superseded_by    TEXT,
        last_accessed_at TEXT,
        data             TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);
    `);
  },
  // v7 — cross-machine dedup loser marker (P3-a auto-convergence). Additive
  // column on the DERIVED memories table; events stay append-only. A duplicate
  // memory (same sourceObservationIds distilled concurrently on two replicas)
  // is marked with the winning memory's id here; the replace-all rebuild
  // backfills it deterministically. Separate ALTER (not folded into the v6
  // CREATE) so DBs already at v6 get the column on upgrade.
  (db) => {
    db.exec('ALTER TABLE memories ADD COLUMN deduped_by TEXT;');
  },
  // v8 — semantic-search embeddings (P3-c). A DERIVED, best-effort auxiliary
  // index keyed by the memory id: one row per consolidated memory text, holding
  // its embedding vector (JSON number[]). UNLIKE the projection tables this is
  // NOT rebuilt by rebuildProjectProjection — embeddings need an async network
  // call, so they are filled out-of-band at boundaries (ensureEmbeddings,
  // never-throw) and survive replace-all rebuilds. `text_hash`+`model` let a
  // rebuild skip re-embedding unchanged text. Absent embeddings simply mean a
  // memory does not participate in semantic ranking (FTS still covers it), so a
  // project with no embeddings endpoint configured behaves exactly as before.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (
        entity_id  TEXT PRIMARY KEY,
        kind       TEXT NOT NULL,
        model      TEXT NOT NULL,
        dim        INTEGER NOT NULL,
        vector     TEXT NOT NULL,
        text_hash  TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_embeddings_kind ON embeddings(kind);
    `);
  },
  // v9 — #62 behavioral lifecycle telemetry: how often a memory was actually
  // injected into an agent context (startup AND mid-session live share).
  // DERIVED-level, observe-only counter: like `last_accessed_at` it is
  // best-effort — carried over across routine rebuilds, reset by a true
  // from-scratch replay — and read by NO ranking/injection consumer; only
  // the `consolidate --report` evidence dump aggregates it.
  (db) => {
    db.exec(
      'ALTER TABLE memories ADD COLUMN injection_count INTEGER NOT NULL DEFAULT 0;',
    );
  },
  // v10 — raw transcript segments: a DERIVED, bounded short-term detail buffer
  // that makes the original conversation content retrievable ALONGSIDE the
  // (lossy, salience-gated) consolidated memories. Like `embeddings` (v8) this is
  // NOT rebuilt by the projector — it is filled out-of-band at the consolidation
  // boundary from the same transcript slice, indexed into search_fts/embeddings
  // under kind='segment', and pruned to a rolling window. A from-scratch replay
  // loses segments (re-accumulated on the next consolidation), same grade as
  // embeddings. Empty table => every retrieval surface is byte-identical to
  // before, so this is purely augmentative.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS segments (
        id         TEXT PRIMARY KEY,
        session_id TEXT,
        created_at TEXT NOT NULL,
        ordinal    INTEGER,
        source     TEXT,
        text       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_segments_created ON segments(created_at);
    `);
  },
  // v11 — per-event provenance (3.0.0 Phase 0). Two NULLABLE additive columns on
  // the append-only events table: `writer` = originating actor identity,
  // `source_project_id` = originating store id. Existing rows read back NULL.
  // Captured on append and preserved across sync, but UNCONSUMED for now (no
  // projection/reader reads them) — the foundation for later writer group-by,
  // workspace union, and origin-scoped recovery. Separate ALTER (not folded into
  // the v1 CREATE) so DBs already past v1 get the columns on upgrade; nullable +
  // no default makes it an O(1) metadata-only change even on large stores.
  (db) => {
    db.exec(`
      ALTER TABLE events ADD COLUMN writer TEXT;
      ALTER TABLE events ADD COLUMN source_project_id TEXT;
    `);
  },
  // v12 — projection provenance lane (3.0.0 M2, `(entity, writer)` projection).
  // A NULLABLE `source_project_id` on each projection table that must not fold
  // a foreign writer's row into local truth (SoT-040). NULL = self (this
  // store); a non-NULL value is the origin store of an event carried in by a
  // workspace union. The entity tables take a plain additive ALTER (O(1),
  // existing rows read back NULL = self). search_fts is a virtual table whose
  // columns can't be ALTERed, so it is rebuilt with the extra UNINDEXED column,
  // copying every existing row with a NULL lane — no empty-index window (the
  // hot telemetry rebuild path uses reindexSearch:false, so a lazy repopulate
  // is NOT guaranteed; carrying rows across keeps search intact on upgrade).
  // Consumed by the single private-vs-union selector; single-writer stores are
  // byte-identical because every local row is NULL-lane.
  (db) => {
    db.exec(`
      ALTER TABLE tasks    ADD COLUMN source_project_id TEXT;
      ALTER TABLE handoffs ADD COLUMN source_project_id TEXT;
      ALTER TABLE sessions ADD COLUMN source_project_id TEXT;
      ALTER TABLE memories ADD COLUMN source_project_id TEXT;
      ALTER TABLE segments ADD COLUMN source_project_id TEXT;

      CREATE VIRTUAL TABLE search_fts_new USING fts5(
        entity_id UNINDEXED,
        kind UNINDEXED,
        text,
        source_project_id UNINDEXED,
        tokenize='unicode61'
      );
      INSERT INTO search_fts_new (entity_id, kind, text, source_project_id)
        SELECT entity_id, kind, text, NULL FROM search_fts;
      DROP TABLE search_fts;
      ALTER TABLE search_fts_new RENAME TO search_fts;
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

/**
 * fs/SQLite failures that all mean the same thing: the memorize data tree
 * can't be written from this process. The dominant real-world cause is a
 * sandbox — notably Codex's default `workspace-write`, whose writable roots
 * don't include `~/.memorize`. better-sqlite3 surfaces that as a bare
 * `unable to open database file`, which leaves the user nothing to act on. (#116)
 */
export function isDataDirUnwritable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === 'EACCES' ||
    code === 'EROFS' ||
    code === 'EPERM' ||
    code === 'SQLITE_CANTOPEN' ||
    /unable to open database file/i.test(error.message)
  );
}

/**
 * Replace the opaque open failure with a message that names the data dir and
 * the exact Codex sandbox fix, while preserving the original error as `cause`.
 */
export function unwritableDataDirError(dbFile: string, cause: Error): Error {
  const root = getMemorizeRoot();
  return new Error(
    `Cannot open the memorize database at ${dbFile} (${cause.message}). ` +
      `The memorize data directory ${root} is not writable from here.\n` +
      `If you are inside a Codex workspace-write sandbox, add "${root}" to ` +
      `sandbox_workspace_write.writable_roots in ~/.codex/config.toml, then ` +
      `restart the codex session.`,
    { cause },
  );
}

function open(dbFile: string): Database.Database {
  try {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const db = new Database(dbFile);
    // Set busy_timeout first so ordinary statements + the IMMEDIATE migration
    // lock wait rather than error; the WAL switch needs its own retry (above).
    db.pragma('busy_timeout = 5000');
    enableWalWithRetry(db);
    runMigrations(db);
    return db;
  } catch (error) {
    if (isDataDirUnwritable(error)) {
      throw unwritableDataDirError(dbFile, error as Error);
    }
    throw error;
  }
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
