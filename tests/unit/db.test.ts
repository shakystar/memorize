import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeAll,
  getDb,
  isDataDirUnwritable,
  openDbAt,
  unwritableDataDirError,
} from '../../src/storage/db.js';
import { getProjectDbFile, getProjectRoot } from '../../src/storage/path-resolver.js';

const VALID_PROJECT_ID = 'proj_l2x_abcdef12';

let tmpRoot: string;
let prevRoot: string | undefined;

beforeEach(() => {
  prevRoot = process.env.MEMORIZE_ROOT;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memorize-db-test-'));
  process.env.MEMORIZE_ROOT = tmpRoot;
});

afterEach(() => {
  closeAll();
  if (prevRoot === undefined) {
    delete process.env.MEMORIZE_ROOT;
  } else {
    process.env.MEMORIZE_ROOT = prevRoot;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Seed the pre-v12 projection tables a real DB would already have at the
 * fixture's pinned `user_version`. The old-shape migration fixtures below only
 * hand-create `events` and fake `user_version`, so the v3/v4/v6/v10 tables that
 * later migrations touch never exist. That was harmless until v12 (the
 * `(entity, writer)` provenance migration) began ALTERing tasks/handoffs/
 * sessions/memories/segments and rebuilding search_fts — on a real DB those all
 * exist by then; here they must be created so the fixture is faithful. Shapes
 * mirror the pre-v12 DDL exactly (see src/storage/db.ts migrations v3/v4/v6/v10);
 * `IF NOT EXISTS` keeps them inert if an in-sequence CREATE also runs on upgrade.
 */
function seedPreV12ProjectionTables(
  db: Database.Database,
  opts: { withMemoriesSegments?: boolean } = {},
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, status TEXT, workstream_id TEXT,
      created_at TEXT, updated_at TEXT, data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS handoffs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, status TEXT, data TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
      entity_id UNINDEXED, kind UNINDEXED, text, tokenize='unicode61'
    );
  `);
  if (opts.withMemoriesSegments) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, kind TEXT, salience INTEGER, created_at TEXT,
        invalid_at TEXT, superseded_by TEXT, last_accessed_at TEXT,
        deduped_by TEXT, injection_count INTEGER NOT NULL DEFAULT 0,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS segments (
        id TEXT PRIMARY KEY, session_id TEXT, created_at TEXT NOT NULL,
        ordinal INTEGER, source TEXT, text TEXT NOT NULL
      );
    `);
  }
}

describe('db', () => {
  it('opens in WAL mode', () => {
    const db = getDb(VALID_PROJECT_ID);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('applies migrations (user_version >= 1) on open', () => {
    const db = getDb(VALID_PROJECT_ID);
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(1);
  });

  it('creates the events table', () => {
    const db = getDb(VALID_PROJECT_ID);
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'",
      )
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('events');
  });

  it('caches one connection per projectId', () => {
    expect(getDb(VALID_PROJECT_ID)).toBe(getDb(VALID_PROJECT_ID));
  });

  it('resolves the db file inside the project root', () => {
    const dbFile = getProjectDbFile(VALID_PROJECT_ID);
    const projectRoot = getProjectRoot(VALID_PROJECT_ID);
    expect(dbFile.startsWith(projectRoot + path.sep)).toBe(true);
    expect(path.basename(dbFile)).toBe('memorize.db');
  });

  function columnType(db: Database.Database, table: string, column: string) {
    const cols = db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string; type: string }>;
    return cols.find((c) => c.name === column)?.type;
  }

  it('stores events.schema_version as TEXT after migrations (fresh db)', () => {
    const db = getDb(VALID_PROJECT_ID);
    // Reached at least the latest known head (bumped per migration; a lower
    // bound keeps this green when later migrations are added).
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(8);
    expect(columnType(db, 'events', 'schema_version')).toBe('TEXT');
  });

  it('creates the CLS projection tables (v6)', () => {
    const db = getDb(VALID_PROJECT_ID);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('observations', 'memories')",
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name).sort()).toEqual(['memories', 'observations']);
  });
});

// #116 — inside a Codex workspace-write sandbox, ~/.memorize is outside the
// writable roots and better-sqlite3 throws a bare `unable to open database
// file`. open() must translate that into an actionable hint instead.
describe('db unwritable-data-dir diagnostics (#116)', () => {
  it('classifies sandbox/permission failures as unwritable', () => {
    const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const erofs = Object.assign(new Error('EROFS'), { code: 'EROFS' });
    const cantOpen = new Error('SQLITE_CANTOPEN: unable to open database file');
    expect(isDataDirUnwritable(eacces)).toBe(true);
    expect(isDataDirUnwritable(erofs)).toBe(true);
    expect(isDataDirUnwritable(cantOpen)).toBe(true);
  });

  it('does not misclassify unrelated errors', () => {
    expect(isDataDirUnwritable(new Error('database is locked'))).toBe(false);
    expect(isDataDirUnwritable('not an error')).toBe(false);
  });

  it('names the data dir + the config.toml fix and preserves the cause', () => {
    const cause = new Error('unable to open database file');
    const err = unwritableDataDirError('/tmp/x/memorize.db', cause);
    expect(err.message).toContain(tmpRoot); // the active MEMORIZE_ROOT
    expect(err.message).toContain('writable_roots');
    expect(err.message).toContain('~/.codex/config.toml');
    expect(err.cause).toBe(cause);
  });

  const isRoot =
    typeof process.getuid === 'function' && process.getuid() === 0;
  // Windows ignores POSIX directory permission bits, so chmod 0o500 does not
  // make the dir unwritable and the open would succeed. root ignores the
  // read-only bit for the same reason — skip the chmod path on both. The
  // classification + message tests above still cover the logic everywhere.
  const cannotDenyDirWrite = isRoot || process.platform === 'win32';

  it.skipIf(cannotDenyDirWrite)(
    'surfaces the actionable hint when the data dir is not writable',
    () => {
      const projectsRoot = path.join(
        tmpRoot,
        'accounts',
        'local_default',
        'projects',
      );
      fs.mkdirSync(projectsRoot, { recursive: true });
      fs.chmodSync(projectsRoot, 0o500); // r-x: cannot create the project dir
      try {
        expect(() => getDb(VALID_PROJECT_ID)).toThrow(
          /workspace-write sandbox/,
        );
      } finally {
        fs.chmodSync(projectsRoot, 0o700);
      }
    },
  );
});

// The v5 migration rebuilds the events table to fix schema_version's type.
// Build an old-shape (v4, INTEGER column) DB populated with rows, then run
// migrations through openDbAt and assert the rebuild is lossless.
describe('db v5 schema_version rebuild', () => {
  const oldShapeRows = [
    { id: 'evt_a', sv: '0.1.0', sid: 's1' },
    { id: 'evt_b', sv: '0.1.0', sid: 's2' },
    { id: 'evt_c', sv: '0.1.0', sid: 's3' },
  ];

  function buildV4Db(dbFile: string): void {
    const db = new Database(dbFile);
    // Minimal subset of the v1 DDL with the OLD (INTEGER) column type.
    db.exec(`
      CREATE TABLE events (
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
      CREATE INDEX idx_events_type  ON events(type);
      CREATE INDEX idx_events_scope ON events(scope_type, scope_id);
    `);
    const insert = db.prepare(
      `INSERT INTO events
         (id, schema_version, created_at, updated_at, type,
          project_id, scope_type, scope_id, actor, payload)
       VALUES (?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
               'task.created', 'proj_x', 'task', ?, 'user', '{}')`,
    );
    for (const row of oldShapeRows) {
      insert.run(row.id, row.sv, row.sid);
    }
    // A real v4 db also has the v3 projection tables + v4 search_fts; recreate
    // them so the later v12 provenance migration (which ALTERs tasks/handoffs/
    // sessions and rebuilds search_fts) has something to act on. memories +
    // segments are created in-sequence by v6/v10 during the upgrade from v4.
    seedPreV12ProjectionTables(db);
    // Pretend v1..v4 have all been applied (this test asserts the v5 rebuild).
    db.pragma('user_version = 4');
    db.close();
  }

  it('rebuilds an old-shape populated db to TEXT with no data loss', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memorize-v5-'));
    const dbFile = path.join(tmp, 'memorize.db');
    try {
      buildV4Db(dbFile);

      const db = openDbAt(dbFile);
      try {
        // Reached the latest user_version and the column is now TEXT (lower
        // bound so later migrations don't re-break this upgrade assertion).
        expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(8);
        const cols = db
          .prepare('PRAGMA table_info(events)')
          .all() as Array<{ name: string; type: string }>;
        expect(cols.find((c) => c.name === 'schema_version')?.type).toBe('TEXT');

        // Row count + seq ordering + data preserved exactly.
        const rows = db
          .prepare('SELECT seq, id, schema_version, scope_id FROM events ORDER BY seq')
          .all() as Array<{ seq: number; id: string; schema_version: string; scope_id: string }>;
        expect(rows.length).toBe(oldShapeRows.length);
        expect(rows.map((r) => r.id)).toEqual(oldShapeRows.map((r) => r.id));
        expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
        expect(rows.map((r) => r.schema_version)).toEqual(
          oldShapeRows.map((r) => r.sv),
        );
        expect(rows.map((r) => r.scope_id)).toEqual(
          oldShapeRows.map((r) => r.sid),
        );

        // Indexes survived the rebuild.
        const indexes = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'",
          )
          .all() as Array<{ name: string }>;
        const names = indexes.map((i) => i.name);
        expect(names).toContain('idx_events_type');
        expect(names).toContain('idx_events_scope');
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// v11 — per-event provenance. Additive NULLABLE columns: a fresh db has them;
// an old-shape (pre-v11) db gains them on upgrade with existing rows NULL.
describe('db v11 provenance columns', () => {
  function eventColumns(db: Database.Database) {
    return db.prepare('PRAGMA table_info(events)').all() as Array<{
      name: string;
      notnull: number;
      dflt_value: unknown;
    }>;
  }

  it('a fresh db has nullable writer + source_project_id on events', () => {
    const db = getDb(VALID_PROJECT_ID);
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(11);
    const cols = eventColumns(db);
    const writer = cols.find((c) => c.name === 'writer');
    const source = cols.find((c) => c.name === 'source_project_id');
    expect(writer).toBeDefined();
    expect(source).toBeDefined();
    // Nullable + no default → O(1) ALTER and legacy rows read NULL.
    expect(writer?.notnull).toBe(0);
    expect(source?.notnull).toBe(0);
    expect(writer?.dflt_value ?? null).toBeNull();
  });

  it('an old-shape db gains the columns on upgrade with existing rows NULL', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memorize-v11-'));
    const dbFile = path.join(tmp, 'memorize.db');
    try {
      // Pre-v11 events table (no provenance columns), one row, one version behind.
      const seed = new Database(dbFile);
      seed.exec(`
        CREATE TABLE events (
          seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, schema_version TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, type TEXT NOT NULL,
          project_id TEXT NOT NULL, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL,
          actor TEXT NOT NULL, payload TEXT NOT NULL
        );
      `);
      seed
        .prepare(
          `INSERT INTO events (id, schema_version, created_at, updated_at, type,
             project_id, scope_type, scope_id, actor, payload)
           VALUES ('evt_legacy', '0.1.0', '2026-01-01T00:00:00.000Z',
             '2026-01-01T00:00:00.000Z', 'task.created', 'proj_x', 'task', 's1',
             'user', '{}')`,
        )
        .run();
      // A real v10 db has the v3/v4/v6/v10 projection tables; recreate them so
      // the v12 provenance migration (ALTER tasks/handoffs/sessions/memories/
      // segments + rebuild search_fts) succeeds. At v10 none are created during
      // upgrade (only v11 + v12 run), so seed the full set here.
      seedPreV12ProjectionTables(seed, { withMemoriesSegments: true });
      seed.pragma('user_version = 10'); // pre-v11; v11 + v12 run on open
      seed.close();

      const db = openDbAt(dbFile);
      try {
        expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(11);
        const names = eventColumns(db).map((c) => c.name);
        expect(names).toContain('writer');
        expect(names).toContain('source_project_id');
        const row = db
          .prepare(
            "SELECT writer, source_project_id FROM events WHERE id = 'evt_legacy'",
          )
          .get() as { writer: string | null; source_project_id: string | null };
        expect(row.writer).toBeNull();
        expect(row.source_project_id).toBeNull();
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('an already-migrated (v12) db gains task_requests on upgrade', () => {
    // Regression for the v13 placement: `runMigrations` replays only from the
    // store's current user_version, so DDL added to an already-shipped
    // migration body never reaches existing stores — the table MUST arrive as
    // a NEW appended migration entry. A fresh-db test can't catch this (it
    // replays everything from 0); this fixture pins a store at v12 and proves
    // reopening creates task_requests.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memorize-v13-'));
    const dbFile = path.join(tmp, 'memorize.db');
    try {
      // A store fully migrated through v12 — no task_requests table. v13 only
      // CREATEs a new table, so the fixture needs no other seeded tables.
      const seed = new Database(dbFile);
      seed.pragma('user_version = 12'); // pre-v13; only v13 runs on open
      seed.close();

      const db = openDbAt(dbFile);
      try {
        expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(13);
        // Querying the table (not just checking sqlite_master) proves the
        // shape readers use is actually reachable on an upgraded store.
        const rows = db
          .prepare('SELECT id, status, target_project_id, source_project_id, created_at, data FROM task_requests')
          .all();
        expect(rows).toEqual([]);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
