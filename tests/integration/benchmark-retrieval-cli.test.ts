import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Spawns the benchmark CLI exactly as `pnpm benchmark:retrieval` does (tsx
// running the script as the entry module). This is the only test that exercises
// the `import.meta.url === pathToFileURL(process.argv[1]).href` entry guard —
// the smoke test imports `runBenchmark` directly and never triggers it. A broken
// guard exits 0 while printing nothing, so asserting the table reaches stdout is
// what catches that regression. Runs on Windows (spawns node, not bash).
const repoRoot = process.cwd();
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const script = path.join(
  repoRoot,
  'scripts/benchmarks/retrieval/run-retrieval-benchmark.ts',
);
const MINI = path.join(
  repoRoot,
  'scripts/benchmarks/retrieval/fixtures/mini-longmemeval.json',
);

let root: string;
let prevRoot: string | undefined;

beforeEach(() => {
  prevRoot = process.env.MEMORIZE_ROOT;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mz-bench-cli-'));
  process.env.MEMORIZE_ROOT = root;
});
afterEach(() => {
  if (prevRoot === undefined) delete process.env.MEMORIZE_ROOT;
  else process.env.MEMORIZE_ROOT = prevRoot;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('benchmark/retrieval CLI entry', () => {
  it(
    'runs the CLI directly and prints the metrics table to stdout',
    () => {
      const res = spawnSync(
        'node',
        [tsxCli, script, 'bm25', '--dataset', MINI, '--sample', '3', '--k', '5'],
        { encoding: 'utf8', env: { ...process.env, MEMORIZE_ROOT: root } },
      );
      expect(res.status, `stderr:\n${res.stderr}`).toBe(0);
      // Header column + the overall row prove the entry guard fired and
      // runBenchmark actually ran (a broken guard exits 0 with empty stdout).
      expect(res.stdout).toContain('recall@5');
      expect(res.stdout).toContain('overall');
    },
    60_000,
  );
});
