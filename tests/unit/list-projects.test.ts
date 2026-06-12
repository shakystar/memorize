import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createProject,
  listProjects,
} from '../../src/services/project-service.js';
import { closeAll } from '../../src/storage/db.js';

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-listproj-'));
  process.env.MEMORIZE_ROOT = join(sandbox, 'root');
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('listProjects', () => {
  it('returns an empty list when no projects exist', async () => {
    expect(await listProjects()).toEqual([]);
  });

  it('returns every created project with its rootPath', async () => {
    const a = await createProject({ title: 'a', rootPath: join(sandbox, 'a') });
    const b = await createProject({ title: 'b', rootPath: join(sandbox, 'b') });
    const listed = await listProjects();
    expect(listed.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    expect(listed.find((p) => p.id === a.id)?.rootPath).toBe(join(sandbox, 'a'));
  });

  it('skips stray non-project entries in the projects dir', async () => {
    await createProject({ title: 'a', rootPath: join(sandbox, 'a') });
    await mkdir(join(sandbox, 'root', 'projects', 'not-a-project!dir'), {
      recursive: true,
    });
    await writeFile(
      join(sandbox, 'root', 'projects', 'stray.txt'),
      'junk',
      'utf8',
    );
    expect(await listProjects()).toHaveLength(1);
  });
});
