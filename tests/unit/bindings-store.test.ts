import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  bindProject,
  resolveProjectIdForPath,
} from '../../src/storage/bindings-store.js';

let sandbox: string;
let originalRoot: string | undefined;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-bindings-'));
  originalRoot = process.env['MEMORIZE_ROOT'];
  process.env['MEMORIZE_ROOT'] = sandbox;
});

afterEach(async () => {
  if (originalRoot === undefined) {
    delete process.env['MEMORIZE_ROOT'];
  } else {
    process.env['MEMORIZE_ROOT'] = originalRoot;
  }
  await rm(sandbox, { recursive: true, force: true });
});

describe('resolveProjectIdForPath', () => {
  it('resolves an exact-path binding', async () => {
    const projectRoot = join(sandbox, 'myproj');
    await bindProject(projectRoot, 'proj_abc_1');

    expect(await resolveProjectIdForPath(projectRoot)).toBe('proj_abc_1');
  });

  it('walks up from a subdirectory to the nearest bound ancestor', async () => {
    const projectRoot = join(sandbox, 'myproj');
    await bindProject(projectRoot, 'proj_abc_1');

    const deep = join(projectRoot, 'src', 'components', 'ui');
    expect(await resolveProjectIdForPath(deep)).toBe('proj_abc_1');
  });

  it('returns undefined when no ancestor is bound', async () => {
    const elsewhere = join(sandbox, 'unrelated', 'nested');
    expect(await resolveProjectIdForPath(elsewhere)).toBeUndefined();
  });

  it('prefers the nearest ancestor when nested projects are bound', async () => {
    const outer = join(sandbox, 'outer');
    const inner = join(outer, 'inner');
    await bindProject(outer, 'proj_outer_1');
    await bindProject(inner, 'proj_inner_1');

    const deepInInner = join(inner, 'src');
    expect(await resolveProjectIdForPath(deepInInner)).toBe('proj_inner_1');

    const deepInOuter = join(outer, 'src');
    expect(await resolveProjectIdForPath(deepInOuter)).toBe('proj_outer_1');
  });
});
