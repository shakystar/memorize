import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readJson, readNdjson } from '../../src/storage/fs-utils.js';

const BOM = '\uFEFF';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'memorize-fs-utils-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readJson — UTF-8 BOM tolerance (#56)', () => {
  it('parses a JSON file with a leading UTF-8 BOM (e.g. hand-edited via PowerShell Out-File)', async () => {
    const filePath = join(dir, 'bindings.json');
    await writeFile(filePath, `${BOM}{ "project": "alpha" }`, 'utf8');
    await expect(readJson<{ project: string }>(filePath)).resolves.toEqual({
      project: 'alpha',
    });
  });

  it('still parses BOM-free JSON', async () => {
    const filePath = join(dir, 'plain.json');
    await writeFile(filePath, '{ "ok": true }', 'utf8');
    await expect(readJson<{ ok: boolean }>(filePath)).resolves.toEqual({ ok: true });
  });
});

describe('readNdjson — UTF-8 BOM tolerance (#56)', () => {
  it('parses an NDJSON file whose first line carries a leading UTF-8 BOM', async () => {
    const filePath = join(dir, 'events.ndjson');
    await writeFile(filePath, `${BOM}{"id":1}\n{"id":2}\n`, 'utf8');
    await expect(readNdjson<{ id: number }>(filePath)).resolves.toEqual([
      { id: 1 },
      { id: 2 },
    ]);
  });
});
