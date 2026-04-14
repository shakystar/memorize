import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

describe('CLI smoke', () => {
  it('prints scaffold usage successfully', () => {
    const result = spawnSync('pnpm', ['exec', 'tsx', 'src/cli/index.ts'], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Memorize CLI scaffold');
  });
});
