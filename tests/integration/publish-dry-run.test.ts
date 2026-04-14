import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

describe('publish dry run validation', () => {
  it('reports that validation assets are excluded from publish output', () => {
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/validate/package-dry-run.ts'],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      status: string;
      includedFiles: string[];
      forbiddenMatches: string[];
    };

    expect(parsed.status).toBe('pass');
    expect(parsed.includedFiles.some((file) => file.startsWith('tests/'))).toBe(
      false,
    );
    expect(parsed.forbiddenMatches).toEqual([]);
  });
});
