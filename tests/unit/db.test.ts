import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeAll, getDb } from '../../src/storage/db.js';
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
});
