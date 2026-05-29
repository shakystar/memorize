import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function runScript(script: string, arg?: string) {
  return spawnSync(
    process.execPath,
    [tsxCliPath, script, ...(arg ? [arg] : [])],
    {
      encoding: 'utf8',
    },
  );
}

describe('benchmark runners', () => {
  it('runs handoff benchmark and returns a pass report', () => {
    const result = runScript(
      'scripts/benchmarks/run-handoff-benchmark.ts',
      'realistic-in-progress-project',
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      status: string;
      metrics: Record<string, number | boolean>;
    };
    expect(parsed.status).toBe('pass');
    expect(Number(parsed.metrics.doneItemsCount)).toBeGreaterThanOrEqual(0);
    expect(parsed.metrics.hasNextAction).toBe(true);
  });

  it('runs conflict benchmark and returns a pass report', () => {
    const result = runScript(
      'scripts/benchmarks/run-conflict-benchmark.ts',
      'conflicted-context-project',
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      status: string;
      metrics: Record<string, number>;
    };
    expect(parsed.status).toBe('pass');
    expect(parsed.metrics.detectedConflictCount).toBeGreaterThan(0);
  });
});
