import { describe, expect, it, vi } from 'vitest';

// Simulate a minimal host where ps-list's underlying `ps`/`wmic` binary is
// absent: the spawn rejects with ENOENT. Process-tree attribution is pure
// best-effort metadata, so every entry point must degrade — never throw — or it
// would take down the SessionStart hook that calls it (regression: a slim
// conformance container without procps crashed `memorize hook pi SessionStart`).
vi.mock('ps-list', () => ({
  default: () => Promise.reject(new Error('spawn ps ENOENT')),
}));

const { findAncestorPidByName, walkAncestorPids } = await import(
  '../../src/shared/process-tree.js'
);

describe('process-tree with no `ps` binary available', () => {
  it('findAncestorPidByName resolves undefined instead of throwing', async () => {
    await expect(
      findAncestorPidByName({
        startPid: process.pid,
        targetNames: ['claude', 'codex'],
      }),
    ).resolves.toBeUndefined();
  });

  it('walkAncestorPids resolves an empty list instead of throwing', async () => {
    await expect(walkAncestorPids(process.pid)).resolves.toEqual([]);
  });
});
