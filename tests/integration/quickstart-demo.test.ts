import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// The quickstart script in examples/quickstart.sh is the canonical 30-second
// demo recorded as the README asset. If anything in this test breaks, the
// public demo would break too — we lock the sequence here so a future
// rename or signature change cannot silently rot the user-facing asset.
describe('examples/quickstart.sh — README demo lock', () => {
  it(
    'runs end-to-end against the local CLI and prints expected milestones',
    { timeout: 60_000 },
    () => {
      const repoRoot = process.cwd();
      const scriptPath = join(repoRoot, 'examples', 'quickstart.sh');
      const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
      const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

      const result = spawnSync('bash', [scriptPath], {
        encoding: 'utf8',
        env: {
          ...process.env,
          // Override the published-package default so we exercise the same
          // source tree the rest of the suite covers, not whatever version
          // happens to be on npm.
          MEMORIZE_BIN: `node ${tsxCliPath} ${cliEntryPath}`,
        },
      });

      expect(result.status, `stderr:\n${result.stderr}`).toBe(0);

      // Each command in the demo prints a recognisable milestone — pin
      // them so renames or output changes surface here before they hit
      // the recording.
      expect(result.stdout).toContain('Initialized project');
      expect(result.stdout).toContain('Imported context files:');
      expect(result.stdout).toContain('Created task');
      expect(result.stdout).toContain('Wire OAuth2 callback');
      expect(result.stdout).toContain('"projectSummary"');
      expect(result.stdout).toContain('Created checkpoint');
      expect(result.stdout).toContain('Memorize is now tracking this project');
    },
  );
});
