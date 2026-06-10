import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

describe('docs consistency (code is the source of truth)', () => {
  it('docs, usage, and i18n READMEs match the shipped contracts', () => {
    const result = spawnSync(
      'node',
      ['node_modules/tsx/dist/cli.mjs', 'scripts/validate/docs-consistency.ts'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);

    const parsed = JSON.parse(result.stdout) as {
      status: string;
      failures: string[];
    };
    // Each failure message names the file and the drift class — fix the doc
    // (or, if the contract legitimately changed, update the validator's
    // pinned expectations alongside it).
    expect(parsed.failures).toEqual([]);
    expect(parsed.status).toBe('pass');
  });
});
