// tests/integration/benchmark-e2e-smoke.test.ts
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeAll } from '../../src/storage/db.js';
import { runE2E } from '../../scripts/benchmarks/e2e/run-e2e-benchmark.js';
import type { Chat } from '../../scripts/benchmarks/e2e/chat-client.js';

const repoRoot = process.cwd();
const MINI = path.join(repoRoot, 'scripts/benchmarks/retrieval/fixtures/mini-longmemeval.json');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const script = path.join(repoRoot, 'scripts/benchmarks/e2e/run-e2e-benchmark.ts');

let root: string;
let prevRoot: string | undefined;
beforeEach(() => {
  prevRoot = process.env.MEMORIZE_ROOT;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mz-e2e-'));
  process.env.MEMORIZE_ROOT = root;
});
afterEach(() => {
  closeAll();
  if (prevRoot === undefined) delete process.env.MEMORIZE_ROOT;
  else process.env.MEMORIZE_ROOT = prevRoot;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

const fixed = (reply: string): Chat => ({ chat: async () => reply });

describe('benchmark/e2e smoke', () => {
  it('runs the pipeline with fake reader/judge (bm25, offline) and scores', async () => {
    const report = await runE2E({
      datasetPath: MINI,
      retrieval: 'bm25',
      k: 5,
      rootPath: path.join(root, 'run'),
      reader: fixed('the answer'),
      judge: fixed('yes'),
      sample: 3,
    });
    expect(report.overall.n).toBe(3);
    expect(report.overall.accuracy).toBeCloseTo(1, 10); // judge says yes for all
    expect(report.skipped).toBe(0);
  });

  it('CLI entry guard fires: hybrid with no embedder fails fast (proves the guard runs)', () => {
    const res = spawnSync('node', [tsxCli, script, '--retrieval', 'hybrid', '--sample', '1'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        MEMORIZE_ROOT: root,
        MEMORIZE_EMBEDDINGS_ENDPOINT: '',
        MEMORIZE_EMBEDDINGS_API_KEY: '',
      },
    });
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`.toLowerCase()).toContain('embedder');
  }, 60_000);
});
