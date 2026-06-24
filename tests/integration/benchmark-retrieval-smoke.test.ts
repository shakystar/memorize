// tests/integration/benchmark-retrieval-smoke.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeAll } from '../../src/storage/db.js';
import { runBenchmark } from '../../scripts/benchmarks/retrieval/run-retrieval-benchmark.js';

const MINI = path.join(
  process.cwd(),
  'scripts/benchmarks/retrieval/fixtures/mini-longmemeval.json',
);

let root: string;
let prevRoot: string | undefined;
beforeEach(() => {
  prevRoot = process.env.MEMORIZE_ROOT;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mz-bench-smoke-'));
  process.env.MEMORIZE_ROOT = root;
});
afterEach(() => {
  closeAll(); // release SQLite handles before rmSync (Windows EBUSY otherwise)
  if (prevRoot === undefined) delete process.env.MEMORIZE_ROOT;
  else process.env.MEMORIZE_ROOT = prevRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('benchmark/retrieval smoke (bm25, mini fixture)', () => {
  it('runs end-to-end and is deterministic across two runs', async () => {
    // Distinct rootPath per run: createProject binds the rootPath, so reusing it
    // across the two runs could collide. Metrics depend only on text/ranking, not
    // paths, so determinism still holds.
    const base = { mode: 'bm25' as const, datasetPath: MINI, ks: [1, 5] };
    const a = await runBenchmark({ ...base, rootPath: path.join(root, 'a') });
    const b = await runBenchmark({ ...base, rootPath: path.join(root, 'b') });
    expect(a.overall.count).toBe(5);
    // all 5 fixtures place gold within top-5 by a distinctive token
    expect(a.overall.recallAtK[5] ?? 0).toBeCloseTo(1, 10);
    expect(b.overall.recallAtK[5] ?? 0).toBeCloseTo(a.overall.recallAtK[5] ?? 0, 10);
    expect(b.overall.mrr).toBeCloseTo(a.overall.mrr, 10);
  });
});
