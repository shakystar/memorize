// tests/unit/benchmark-e2e-checkpoint.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendCheckpoint,
  loadCheckpoint,
} from '../../scripts/benchmarks/e2e/checkpoint.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mz-ckpt-'));
  file = path.join(dir, 'ckpt.jsonl');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('benchmark/e2e checkpoint', () => {
  it('returns an empty map when the file does not exist', () => {
    expect(loadCheckpoint(file).size).toBe(0);
  });

  it('round-trips appended records keyed by questionId, preserving fields', () => {
    appendCheckpoint(file, { questionId: 'q1', questionType: 'temporal', isAbstention: false, correct: true });
    appendCheckpoint(file, { questionId: 'q2_abs', questionType: 'multi', isAbstention: true, correct: false });

    const done = loadCheckpoint(file);
    expect(done.size).toBe(2);
    expect(done.get('q1')).toEqual({ questionId: 'q1', questionType: 'temporal', isAbstention: false, correct: true });
    expect(done.get('q2_abs')?.correct).toBe(false);
    expect(done.get('q2_abs')?.isAbstention).toBe(true);
  });

  it('skips a truncated final line (an abrupt kill mid-append) without losing earlier records', () => {
    appendCheckpoint(file, { questionId: 'q1', questionType: 'temporal', isAbstention: false, correct: true });
    // Simulate a process killed partway through writing the second line.
    fs.appendFileSync(file, '{"questionId":"q2","questionType":"mul');

    const done = loadCheckpoint(file);
    expect(done.size).toBe(1);
    expect(done.has('q1')).toBe(true);
    expect(done.has('q2')).toBe(false);
  });
});
