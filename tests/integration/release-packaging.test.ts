import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('release packaging', () => {
  it('builds a real executable CLI entrypoint at dist/cli.js', async () => {
    const build = spawnSync('pnpm', ['build'], { encoding: 'utf8' });
    expect(build.status).toBe(0);

    const cliOutput = await readFile('dist/cli.js', 'utf8');
    expect(cliOutput.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('keeps tests and validation assets out of the publish tarball', () => {
    const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);

    const packInfo = JSON.parse(result.stdout) as Array<{
      files: Array<{ path: string }>;
    }>;
    const publishedPaths = packInfo[0]?.files.map((file) => file.path) ?? [];

    expect(publishedPaths.includes('dist/tests/cli.test.js')).toBe(false);
    expect(
      publishedPaths.some((file) => file.startsWith('dist/scripts/')),
    ).toBe(false);
  });

  it('validates the actual packed output, not only package.json declarations', () => {
    const result = spawnSync(
      'node',
      ['node_modules/tsx/dist/cli.mjs', 'scripts/validate/package-dry-run.ts'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);

    const parsed = JSON.parse(result.stdout) as {
      status: string;
      forbiddenMatches: string[];
      binPathValid: boolean;
    };

    expect(parsed.status).toBe('pass');
    expect(parsed.binPathValid).toBe(true);
    expect(parsed.forbiddenMatches).toEqual([]);
  });
});
