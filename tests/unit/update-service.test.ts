import { describe, expect, it } from 'vitest';

import {
  getCurrentVersion,
  isNewerVersion,
  runSelfUpdate,
  type RefreshResult,
  type UpdateDeps,
} from '../../src/services/update-service.js';

const EMPTY_REFRESH: RefreshResult = {
  codexRefreshed: false,
  claudeRefreshed: [],
  reimported: [],
  failures: [],
};

interface FakeCalls {
  npmCapture: string[][];
  npmInherit: string[][];
  runMemorize: string[][];
  refreshed: number;
}

function fakeDeps(overrides: Partial<UpdateDeps> = {}): {
  deps: UpdateDeps;
  calls: FakeCalls;
} {
  const calls: FakeCalls = {
    npmCapture: [],
    npmInherit: [],
    runMemorize: [],
    refreshed: 0,
  };
  const deps: UpdateDeps = {
    npmCapture: async (args) => {
      calls.npmCapture.push(args);
      return '999.0.0\n';
    },
    npmInherit: async (args) => {
      calls.npmInherit.push(args);
      return 0;
    },
    whichMemorize: () => 'C:/fake/memorize',
    runMemorize: async (args) => {
      calls.runMemorize.push(args);
      return 0;
    },
    refresh: async () => {
      calls.refreshed += 1;
      return EMPTY_REFRESH;
    },
    ...overrides,
  };
  return { deps, calls };
}

describe('isNewerVersion', () => {
  it('compares numerically per segment', () => {
    expect(isNewerVersion('2.10.0', '2.9.9')).toBe(true);
    expect(isNewerVersion('2.3.0', '2.3.0')).toBe(false);
    expect(isNewerVersion('2.2.9', '2.3.0')).toBe(false);
    expect(isNewerVersion('3.0.0', '2.99.99')).toBe(true);
  });

  it('ignores prerelease suffixes (v1 scope)', () => {
    expect(isNewerVersion('2.4.0-rc.1', '2.3.0')).toBe(true);
  });
});

describe('runSelfUpdate', () => {
  it('bails with exit 1 + guidance when memorize is not globally installed', async () => {
    const { deps, calls } = fakeDeps({ whichMemorize: () => null });
    const lines: string[] = [];
    const code = await runSelfUpdate(deps, (l) => lines.push(l));
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('npm install -g @shakystar/memorize');
    expect(calls.npmInherit).toHaveLength(0);
  });

  it('exits 1 with a clear message when the registry is unreachable', async () => {
    const { deps, calls } = fakeDeps({
      npmCapture: async () => {
        throw new Error('ETIMEDOUT');
      },
    });
    const lines: string[] = [];
    const code = await runSelfUpdate(deps, (l) => lines.push(l));
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('registry');
    expect(calls.npmInherit).toHaveLength(0);
    expect(calls.refreshed).toBe(0);
  });

  it('already up to date: skips npm install and runs refresh in-process', async () => {
    const { deps, calls } = fakeDeps({
      npmCapture: async () => `${getCurrentVersion()}\n`,
    });
    const code = await runSelfUpdate(deps, () => {});
    expect(code).toBe(0);
    expect(calls.npmInherit).toHaveLength(0);
    expect(calls.runMemorize).toHaveLength(0);
    expect(calls.refreshed).toBe(1);
  });

  it('outdated: npm install -g then re-execs the new binary with --post-only', async () => {
    const { deps, calls } = fakeDeps();
    const code = await runSelfUpdate(deps, () => {});
    expect(code).toBe(0);
    expect(calls.npmInherit).toEqual([
      ['install', '-g', '@shakystar/memorize@latest'],
    ]);
    expect(calls.runMemorize).toEqual([['update', '--post-only']]);
    expect(calls.refreshed).toBe(0); // refresh belongs to the NEW binary
  });

  it('npm install failure: propagates exit code and never re-execs', async () => {
    const { deps, calls } = fakeDeps({ npmInherit: async () => 7 });
    const code = await runSelfUpdate(deps, () => {});
    expect(code).toBe(7);
    expect(calls.runMemorize).toHaveLength(0);
  });

  it('refresh failures make the up-to-date path exit 1', async () => {
    const { deps } = fakeDeps({
      npmCapture: async () => `${getCurrentVersion()}\n`,
      refresh: async () => ({
        ...EMPTY_REFRESH,
        failures: [{ target: 'claude hooks: /x', message: 'EACCES' }],
      }),
    });
    const code = await runSelfUpdate(deps, () => {});
    expect(code).toBe(1);
  });
});
