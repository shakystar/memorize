import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('publish-ready package shape', () => {
  it('defines package file boundaries to avoid shipping validation assets', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      files?: string[];
    };

    expect(packageJson.files).toBeDefined();
    expect(packageJson.files).toContain('dist');
    expect(packageJson.files).not.toContain('tests');
    expect(packageJson.files).not.toContain('scripts');
  });
});
