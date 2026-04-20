import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

describe('CLI smoke', () => {
  it('prints usage successfully and advertises the day-to-day commands', () => {
    const result = spawnSync('pnpm', ['exec', 'tsx', 'src/cli/index.ts'], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Memorize');
    expect(result.stdout).toContain('memorize doctor');
    expect(result.stdout).toContain('memorize task list');
    expect(result.stdout).toContain('AGENT_GUIDE.md');
    // `launch` is intentionally NOT advertised in the public usage; the
    // command still works for fallback use but is no longer surfaced.
    expect(result.stdout).not.toContain('memorize launch');
  });
});
