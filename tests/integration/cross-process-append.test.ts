import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeAll } from '../../src/storage/db.js';
import { readEvents } from '../../src/storage/event-store.js';

// Real multi-process contention. The in-process concurrency tests
// (concurrent-mutation, hook-race) all share ONE cached better-sqlite3
// connection inside a single process, where synchronous better-sqlite3
// self-serializes — so cross-process file-lock contention goes untested.
// Here we launch N SEPARATE OS processes that each open their OWN connection
// and hammer the SAME project DB concurrently, exercising WAL + busy_timeout.

let sandbox: string;
let memorizeRoot: string;

const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const workerPath = join(repoRoot, 'tests', 'harness', 'append-worker.ts');

const PROJECT_ID = 'proj_xproc_append01';

interface WorkerResult {
  code: number | null;
  stderr: string;
}

function runWorker(count: number): Promise<WorkerResult> {
  return new Promise((resolve) => {
    const child = spawn(
      'node',
      [tsxCliPath, workerPath, PROJECT_ID, String(count)],
      {
        cwd: sandbox,
        env: { ...process.env, MEMORIZE_ROOT: memorizeRoot },
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-xproc-'));
  memorizeRoot = join(sandbox, '.memorize-home');
  process.env.MEMORIZE_ROOT = memorizeRoot;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('cross-process event append contention', () => {
  it(
    'N separate processes append to the same DB with zero lost writes and zero SQLITE_BUSY',
    { timeout: 60_000 },
    async () => {
      const PROCESSES = 4;
      const PER_PROCESS = 25;
      const expected = PROCESSES * PER_PROCESS;

      const results = await Promise.all(
        Array.from({ length: PROCESSES }, () => runWorker(PER_PROCESS)),
      );

      // No process propagated SQLITE_BUSY (or any other) error. The append
      // transactions themselves never contend (write-first INSERT, WAL +
      // busy_timeout). What this test surfaced was a COLD-OPEN race: several
      // fresh processes opening the same new DB at once collided in db.ts
      // during (a) the `journal_mode = WAL` switch (which does NOT honor
      // busy_timeout) and (b) concurrent first-time migrations re-running the
      // v4 `CREATE VIRTUAL TABLE search_fts` (no IF NOT EXISTS). Fixed in
      // db.ts with a WAL-switch retry + an IMMEDIATE migration lock that
      // re-reads user_version inside the lock. See db.ts for the rationale.
      for (const r of results) {
        expect(r.stderr).not.toMatch(/SQLITE_BUSY/);
        expect(r.code).toBe(0);
      }

      // Zero lost writes: every appended event landed exactly once.
      closeAll();
      const events = await readEvents(PROJECT_ID);
      expect(events.length).toBe(expected);
      // All ids unique (no double-insert / clobber).
      expect(new Set(events.map((e) => e.id)).size).toBe(expected);
    },
  );
});
