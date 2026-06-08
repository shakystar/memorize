import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeAll, getDb, openDbAt } from '../../src/storage/db.js';
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
    expect(db.pragma('user_version', { simple: true })).toBe(7);
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
    // Pretend v1..v4 have all been applied (we only need events for this test).
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
        // Reached the new user_version and the column is now TEXT.
        expect(db.pragma('user_version', { simple: true })).toBe(7);
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
