import { describe, expect, it } from 'vitest';

import {
  findAncestorPidByName,
  isProcessAlive,
} from '../../src/shared/process-tree.js';

describe('isProcessAlive', () => {
  it('returns true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('returns false for non-positive / non-integer pids', () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(Number.NaN)).toBe(false);
  });

  it('returns false for a pid that almost certainly does not exist', () => {
    // 32-bit pid_t max on linux is 4194304; 99999999 is comfortably
    // above any system's pid_max so we should always get ESRCH.
    expect(isProcessAlive(99_999_999)).toBe(false);
  });
});

describe('findAncestorPidByName', () => {
  it('returns undefined when no ancestor matches the target names', () => {
    // Vitest itself does not run under a process named 'claude' or
    // 'codex', so a walk from the current ppid must miss within the
    // hop limit. Pure best-effort guarantee: undefined, never throws.
    const result = findAncestorPidByName({
      startPid: process.pid,
      targetNames: ['this-name-will-never-match-xyz'],
      maxHops: 4,
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined for a pid that no longer exists', () => {
    expect(
      findAncestorPidByName({
        startPid: 99_999_999,
        targetNames: ['anything'],
      }),
    ).toBeUndefined();
  });
});
