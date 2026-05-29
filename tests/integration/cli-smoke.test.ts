import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

describe('CLI smoke', () => {
  it('prints usage successfully and advertises the day-to-day commands', () => {
    const result = spawnSync(process.execPath, [tsxCliPath, cliEntryPath], {
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Memorize');
    expect(result.stdout).toContain('memorize doctor');
    expect(result.stdout).toContain('memorize task list');
    expect(result.stdout).toContain('AGENT_GUIDE.md');
    expect(result.stdout).not.toContain('memorize launch');
  });
});
