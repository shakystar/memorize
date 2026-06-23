import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createProject,
  getBoundProjectId,
  listProjects,
} from '../../src/services/project-service.js';
import { setupProject } from '../../src/services/setup-service.js';
import {
  computeRepoIdentity,
  normalizeOriginUrl,
} from '../../src/services/repo-identity.js';
import { closeAll } from '../../src/storage/db.js';

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/** Create a real git repo so computeRepoIdentity() has something to read. */
async function makeRepo(dir: string, originUrl?: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@memorize.dev']);
  git(dir, ['config', 'user.name', 'memorize test']);
  if (originUrl) git(dir, ['remote', 'add', 'origin', originUrl]);
  await writeFile(join(dir, 'README.md'), '# fixture\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
}

let sandbox: string;

beforeEach(async () => {
  // os.tmpdir() is a symlink on macOS (/var -> /private/var); canonicalize so
  // the paths we pass match the realpath bindings resolve under.
  sandbox = await realpath(await mkdtemp(join(tmpdir(), 'memorize-relodetect-')));
  process.env.MEMORIZE_ROOT = join(sandbox, 'root');
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('setupProject move detection (#145)', () => {
  it('auto-relocates a moved repo matched by origin URL when the old path is gone', async () => {
    const oldPath = join(sandbox, 'old', 'widgets');
    await makeRepo(oldPath, 'git@github.com:acme/widgets.git');

    const first = await setupProject(oldPath);
    expect(first.relocated).toBe(false);
    expect(first.project.originUrl).toBe('github.com/acme/widgets');
    const originalId = first.project.id;

    // Move the repo (its .git travels with it; the old path disappears).
    const newPath = join(sandbox, 'new', 'widgets');
    await mkdir(join(sandbox, 'new'), { recursive: true });
    await rename(oldPath, newPath);

    const second = await setupProject(newPath);

    expect(second.relocated).toBe(true);
    expect(second.project.id).toBe(originalId); // same store => memory retained
    expect(second.warnings).toEqual([]);
    expect(await getBoundProjectId(newPath)).toBe(originalId);
    // No empty duplicate was minted.
    expect(await listProjects()).toHaveLength(1);
  });

  it('auto-relocates a remote-less repo matched by root commit', async () => {
    const oldPath = join(sandbox, 'old', 'localrepo');
    await makeRepo(oldPath); // no origin

    const first = await setupProject(oldPath);
    expect(first.project.originUrl).toBeUndefined();
    expect(first.project.rootCommit).toBeTruthy();
    const originalId = first.project.id;

    const newPath = join(sandbox, 'new', 'localrepo');
    await mkdir(join(sandbox, 'new'), { recursive: true });
    await rename(oldPath, newPath);

    const second = await setupProject(newPath);
    expect(second.relocated).toBe(true);
    expect(second.project.id).toBe(originalId);
  });

  it('disambiguates several moved monorepo peers by basename', async () => {
    // A real monorepo: one .git, several subdir projects that share BOTH origin
    // and root commit — only the basename/path tells them apart.
    const mono = join(sandbox, 'old', 'mono');
    await makeRepo(mono, 'git@github.com:acme/mono.git');
    await mkdir(join(mono, 'svc-a'), { recursive: true });
    await mkdir(join(mono, 'svc-b'), { recursive: true });
    const a = await setupProject(join(mono, 'svc-a'));
    await setupProject(join(mono, 'svc-b'));

    // Move the whole monorepo; both subdir paths vanish.
    await mkdir(join(sandbox, 'new'), { recursive: true });
    await rename(mono, join(sandbox, 'new', 'mono'));

    // svc-a and svc-b share origin+rootCommit, so only the basename picks svc-a.
    const result = await setupProject(join(sandbox, 'new', 'mono', 'svc-a'));
    expect(result.relocated).toBe(true);
    expect(result.project.id).toBe(a.project.id);
    expect(await listProjects()).toHaveLength(2);
  });

  it('does NOT auto-relocate a fork: same root commit, different origin URL', async () => {
    // Upstream project.
    const upstream = join(sandbox, 'old', 'foo');
    await makeRepo(upstream, 'git@github.com:alice/foo.git');
    const up = await setupProject(upstream);

    // Fork = a copy of the repo (so the root commit is identical), repointed at
    // a different origin. Then the upstream path is removed (gone on disk).
    const fork = join(sandbox, 'new', 'foo');
    await mkdir(join(sandbox, 'new'), { recursive: true });
    await cp(upstream, fork, { recursive: true });
    git(fork, ['remote', 'set-url', 'origin', 'git@github.com:bob/foo.git']);
    await rm(upstream, { recursive: true, force: true });

    const result = await setupProject(fork);

    // Different origin must win over the shared root commit — never fold the
    // fork into the upstream project (that would itself orphan/merge memory).
    expect(result.relocated).toBe(false);
    expect(result.project.id).not.toBe(up.project.id);
    expect(result.project.originUrl).toBe('github.com/bob/foo');
    expect(await listProjects()).toHaveLength(2);
  });

  it('warns and creates (never auto) when multiple moved peers are ambiguous', async () => {
    const mono = join(sandbox, 'old', 'mono');
    await makeRepo(mono, 'git@github.com:acme/mono.git');
    await mkdir(join(mono, 'svc-a'), { recursive: true });
    await mkdir(join(mono, 'svc-b'), { recursive: true });
    await setupProject(join(mono, 'svc-a'));
    await setupProject(join(mono, 'svc-b'));

    await mkdir(join(sandbox, 'new'), { recursive: true });
    await rename(mono, join(sandbox, 'new', 'mono'));

    // A THIRD subdir whose basename matches neither moved peer → ambiguous.
    const combined = join(sandbox, 'new', 'mono', 'svc-c');
    await mkdir(combined, { recursive: true });

    const result = await setupProject(combined);
    expect(result.relocated).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('project relocate');
    // Created a new project rather than silently adopting one of the peers.
    expect(await listProjects()).toHaveLength(3);
  });

  it('warns (never auto) for a legacy project with no captured identity', async () => {
    // Simulate a pre-#145 project: created directly without identity, old path
    // gone, same basename as the new repo.
    const gonePath = join(sandbox, 'old', 'legacy');
    const legacy = await createProject({ title: 'legacy', rootPath: gonePath });
    expect(legacy.originUrl).toBeUndefined();

    const newPath = join(sandbox, 'new', 'legacy');
    await makeRepo(newPath, 'git@github.com:acme/legacy.git');

    const result = await setupProject(newPath);
    expect(result.relocated).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(legacy.id);
    expect(result.project.id).not.toBe(legacy.id); // a new project, not adopted
  });

  it('does NOT relocate when the old path still exists (sibling checkout)', async () => {
    const pathA = join(sandbox, 'a', 'widgets');
    await makeRepo(pathA, 'git@github.com:acme/widgets.git');
    await setupProject(pathA);

    // A second working copy of the same repo, A still present.
    const pathB = join(sandbox, 'b', 'widgets');
    await makeRepo(pathB, 'git@github.com:acme/widgets.git');
    const result = await setupProject(pathB);

    expect(result.relocated).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(await listProjects()).toHaveLength(2);
  });

  it('creates without warning for a plain non-git directory', async () => {
    const dir = join(sandbox, 'plain');
    await mkdir(dir, { recursive: true });

    const result = await setupProject(dir);
    expect(result.relocated).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.project.originUrl).toBeUndefined();
    expect(computeRepoIdentity(dir)).toEqual({});
  });
});

describe('normalizeOriginUrl', () => {
  it('collapses scp / https / ssh / credentials / .git / slash to one key', () => {
    const key = 'github.com/acme/widgets';
    expect(normalizeOriginUrl('git@github.com:acme/widgets.git')).toBe(key);
    expect(normalizeOriginUrl('https://github.com/acme/widgets.git')).toBe(key);
    expect(normalizeOriginUrl('https://user:token@github.com/acme/widgets.git/')).toBe(key);
    expect(normalizeOriginUrl('ssh://git@github.com/acme/widgets')).toBe(key);
  });

  it('returns empty for blank input', () => {
    expect(normalizeOriginUrl('   ')).toBe('');
  });
});
