import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runProjectCommand } from '../../src/cli/commands/project.js';
import {
  getBindingForPath,
  getBoundProjectId,
  listProjects,
} from '../../src/services/project-service.js';
import { setupProject } from '../../src/services/setup-service.js';
import { listImportedRules } from '../../src/services/projection-store.js';
import { closeAll } from '../../src/storage/db.js';

let sandbox: string;

beforeEach(async () => {
  // os.tmpdir() is a symlink on macOS (/var -> /private/var); canonicalize so
  // the paths we pass match the realpath bindings resolve under.
  sandbox = await realpath(await mkdtemp(join(tmpdir(), 'memorize-ancestor-')));
  process.env.MEMORIZE_ROOT = join(sandbox, 'root');
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('setupProject exact vs ancestor binding (#151)', () => {
  it('THROWS in a subdir of a bound project and does not adopt/import/pollute', async () => {
    const parent = join(sandbox, 'parent');
    await mkdir(parent, { recursive: true });
    await writeFile(join(parent, 'CLAUDE.md'), '# parent rules\n');

    const first = await setupProject(parent);
    const ancestorId = first.project.id;

    const child = join(parent, 'child');
    await mkdir(child, { recursive: true });
    await writeFile(join(child, 'CLAUDE.md'), '# child-only rules\n');

    const importedBefore = listImportedRules(ancestorId).length;
    const countBefore = (await listProjects()).length;

    await expect(setupProject(child)).rejects.toThrow(/project init/);

    // No new project minted.
    expect(await listProjects()).toHaveLength(countBefore);
    // The ancestor's imported rules were NOT mutated by the child's CLAUDE.md.
    expect(listImportedRules(ancestorId)).toHaveLength(importedBefore);
    // Child still resolves operationally to the ancestor (walk-up unchanged).
    expect(await getBoundProjectId(child)).toBe(ancestorId);
  });

  it('error names the ancestor project title and id', async () => {
    const parent = join(sandbox, 'parent');
    await mkdir(parent, { recursive: true });
    const first = await setupProject(parent);

    const child = join(parent, 'child');
    await mkdir(child, { recursive: true });

    await expect(setupProject(child)).rejects.toThrow(
      new RegExp(first.project.id),
    );
  });

  it('re-setup at the exact bound root is idempotent (no throw, same id)', async () => {
    const dir = join(sandbox, 'proj');
    await mkdir(dir, { recursive: true });

    const first = await setupProject(dir);
    const second = await setupProject(dir);

    expect(second.project.id).toBe(first.project.id);
    expect(await listProjects()).toHaveLength(1);
  });

  it('creates a project in a dir with no ancestor binding', async () => {
    const dir = join(sandbox, 'fresh');
    await mkdir(dir, { recursive: true });

    const result = await setupProject(dir);
    expect(result.project.id).toBeTruthy();
    expect(await listProjects()).toHaveLength(1);
  });

  it('init in a subdir creates a NEW nested project, ancestor untouched', async () => {
    const parent = join(sandbox, 'parent');
    await mkdir(parent, { recursive: true });
    const first = await setupProject(parent);
    const ancestorId = first.project.id;

    const child = join(parent, 'child');
    await mkdir(child, { recursive: true });

    await runProjectCommand(['init'], { cwd: child });

    const childBinding = await getBindingForPath(child);
    expect(childBinding?.kind).toBe('exact');
    expect(childBinding?.projectId).not.toBe(ancestorId);
    expect(childBinding?.matchedPath).toBe(child);

    expect(await listProjects()).toHaveLength(2);
  });

  it('init at an exact-bound root still errors without --force', async () => {
    const dir = join(sandbox, 'proj');
    await mkdir(dir, { recursive: true });
    await setupProject(dir);

    await expect(runProjectCommand(['init'], { cwd: dir })).rejects.toThrow(
      /already bound/,
    );
  });
});
