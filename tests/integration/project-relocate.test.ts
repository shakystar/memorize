import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createProject,
  getBoundProjectId,
  relocateProject,
} from '../../src/services/project-service.js';
import { setupProject } from '../../src/services/setup-service.js';
import { closeAll } from '../../src/storage/db.js';

let sandbox: string;
let pathA: string;
let pathB: string;

beforeEach(async () => {
  // Canonicalize the sandbox: os.tmpdir() is a symlink on macOS (/var ->
  // /private/var) and short-named on Windows, so the raw mkdtemp path differs
  // from the realpath the OS hands back for process.cwd(). Without this the
  // path the test passes in and the path bindings resolve under diverge.
  sandbox = await realpath(await mkdtemp(join(tmpdir(), 'memorize-relocate-')));
  process.env.MEMORIZE_ROOT = join(sandbox, 'root');
  pathA = join(sandbox, 'old-location', 'emis');
  pathB = join(sandbox, 'new-location', 'emis');
  await mkdir(pathA, { recursive: true });
  await mkdir(pathB, { recursive: true });
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('relocateProject (#124)', () => {
  it('rebinds the SAME project id to the new path so memory is retained', async () => {
    const original = await createProject({ title: 'emis', rootPath: pathA });

    const { project } = await relocateProject({
      newPath: pathB,
      projectId: original.id,
    });

    // Same id => same ~/.memorize/projects/<id>/ store => memory intact.
    expect(project.id).toBe(original.id);
    expect(project.rootPath).toBe(pathB);

    // Resolving at the new path returns the original project id.
    expect(await getBoundProjectId(pathB)).toBe(original.id);
  });

  it('stops the old path from silently minting a NEW empty project after relocate', async () => {
    const original = await createProject({ title: 'emis', rootPath: pathA });
    await relocateProject({ newPath: pathB, projectId: original.id });

    // The moved repo at path B is the original project, with its memory.
    const setupAtB = await setupProject(pathB);
    expect(setupAtB.project.id).toBe(original.id);

    // The old path no longer resolves to the original project (stale binding
    // was dropped), so it does not silently keep serving the moved project.
    expect(await getBoundProjectId(pathA)).toBeUndefined();
  });

  it('identifies the source project by --from old path', async () => {
    const original = await createProject({ title: 'emis', rootPath: pathA });

    const { project } = await relocateProject({
      newPath: pathB,
      fromPath: pathA,
    });

    expect(project.id).toBe(original.id);
    expect(await getBoundProjectId(pathB)).toBe(original.id);
  });

  it('is an idempotent no-op when already bound to the new path', async () => {
    const original = await createProject({ title: 'emis', rootPath: pathB });

    const result = await relocateProject({
      newPath: pathB,
      projectId: original.id,
    });

    expect(result.alreadyBound).toBe(true);
    expect(result.project.id).toBe(original.id);
    expect(result.project.rootPath).toBe(pathB);
  });

  it('errors when the target project id does not exist', async () => {
    await expect(
      relocateProject({ newPath: pathB, projectId: 'proj_does_not_exist' }),
    ).rejects.toThrow(/Project not found/);
  });

  it('errors when the new path is already bound to a different project', async () => {
    const moved = await createProject({ title: 'emis', rootPath: pathA });
    // pathB is independently owned by another project.
    await createProject({ title: 'other', rootPath: pathB });

    await expect(
      relocateProject({ newPath: pathB, projectId: moved.id }),
    ).rejects.toThrow(/already bound to a different project/);
  });

  it('errors when the new path does not exist on disk', async () => {
    const original = await createProject({ title: 'emis', rootPath: pathA });

    await expect(
      relocateProject({
        newPath: join(sandbox, 'nowhere'),
        projectId: original.id,
      }),
    ).rejects.toThrow(/does not exist on disk/);
  });

  it('errors when neither --project nor --from is given', async () => {
    await expect(relocateProject({ newPath: pathB })).rejects.toThrow(
      /--project|--from/,
    );
  });
});
