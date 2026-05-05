import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withFileLock } from '../../src/storage/file-lock.js';

let lockDir: string;

beforeEach(async () => {
  lockDir = await mkdtemp(join(tmpdir(), 'memorize-file-lock-'));
});

afterEach(async () => {
  await rm(lockDir, { recursive: true, force: true });
});

describe('withFileLock — pick-then-claim mutual exclusion', () => {
  it('runs the body and removes the lock file on completion', async () => {
    const result = await withFileLock(lockDir, 'sample', async () => {
      // The lock file should exist while the body runs.
      const body = await readFile(join(lockDir, 'sample.lock'), 'utf8');
      expect(JSON.parse(body)).toMatchObject({ pid: process.pid });
      return 42;
    });
    expect(result).toBe(42);
    await expect(readFile(join(lockDir, 'sample.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('removes the lock file even when the body throws', async () => {
    await expect(
      withFileLock(lockDir, 'sample', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(readFile(join(lockDir, 'sample.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('serializes concurrent acquirers — second waits for the first to finish', async () => {
    // Two parallel `withFileLock` calls on the same name; the inner
    // bodies record their entry and exit timestamps. With proper
    // serialization the second body's entry must be after the first's
    // exit. Without serialization both run interleaved and the
    // ordering invariant fails. This is the picker-race regression
    // pin: same shape as two SessionStart hooks racing.
    const events: Array<{ which: 'A' | 'B'; phase: 'enter' | 'exit'; t: number }> = [];
    const bodyA = withFileLock(lockDir, 'race', async () => {
      events.push({ which: 'A', phase: 'enter', t: Date.now() });
      await new Promise((r) => setTimeout(r, 80));
      events.push({ which: 'A', phase: 'exit', t: Date.now() });
    });
    const bodyB = withFileLock(lockDir, 'race', async () => {
      events.push({ which: 'B', phase: 'enter', t: Date.now() });
      await new Promise((r) => setTimeout(r, 20));
      events.push({ which: 'B', phase: 'exit', t: Date.now() });
    });
    await Promise.all([bodyA, bodyB]);

    // Whichever ran first, its exit must precede the other's enter.
    const first = events[0]!.which;
    const enters = events.filter((e) => e.phase === 'enter');
    const exits = events.filter((e) => e.phase === 'exit');
    const firstExit = exits.find((e) => e.which === first)!.t;
    const secondEnter = enters.find((e) => e.which !== first)!.t;
    expect(secondEnter).toBeGreaterThanOrEqual(firstExit);
  });

  it('force-reclaims a stale lock once holdTimeoutMs has passed', async () => {
    // Plant a "leaked" lock as if a prior holder crashed without
    // cleanup. With holdTimeoutMs=120 the second acquirer must
    // reclaim within roughly that window rather than blocking
    // forever — this is the safety valve, not the happy path.
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, 'stale.lock'),
      JSON.stringify({ pid: 999_999_999, acquiredAt: '2020-01-01T00:00:00.000Z' }),
      'utf8',
    );
    const start = Date.now();
    const result = await withFileLock(
      lockDir,
      'stale',
      async () => 'reclaimed',
      { holdTimeoutMs: 120, retryIntervalMs: 25 },
    );
    const elapsed = Date.now() - start;
    expect(result).toBe('reclaimed');
    // Should have waited roughly the timeout (~120ms) before
    // reclaiming, but not orders of magnitude longer.
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(2_000);
  });
});
