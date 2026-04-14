import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setupProject } from '../../src/services/setup-service.js';
import { getBoundProjectId } from '../../src/services/project-service.js';
import { loadStartContext } from '../../src/services/context-service.js';

let sandbox: string;
let memorizeRoot: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-conflict-detection-'));
  memorizeRoot = join(sandbox, '.memorize-home');
  process.env.MEMORIZE_ROOT = memorizeRoot;
  await mkdir(join(sandbox, '.cursor', 'rules'), { recursive: true });
  await writeFile(
    join(sandbox, 'AGENTS.md'),
    '# Project guidance\nKeep commits small.\n',
    'utf8',
  );
  await writeFile(
    join(sandbox, 'CLAUDE.md'),
    '# Claude guidance\nSquash changes into one final commit.\n',
    'utf8',
  );
  await writeFile(
    join(sandbox, '.cursor', 'rules', 'docs.mdc'),
    'Update docs on every change.',
    'utf8',
  );
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
  delete process.env.MEMORIZE_ROOT;
});

describe('semantic conflict detection', () => {
  it('surfaces conflicts when imported guidance contradicts on commit behavior', async () => {
    await setupProject(sandbox);
    const projectId = await getBoundProjectId(sandbox);
    if (!projectId) throw new Error('Expected project id after setup.');

    const startup = await loadStartContext({ projectId });
    expect(startup.openConflicts.length).toBeGreaterThan(0);

    const projectsDir = join(memorizeRoot, 'projects');
    const projectFolders = await readdir(projectsDir);
    const conflictsDir = join(projectsDir, projectFolders[0]!, 'conflicts');
    const conflictFiles = await readdir(conflictsDir);
    expect(conflictFiles.length).toBeGreaterThan(0);

    const conflictJson = await readFile(
      join(conflictsDir, conflictFiles[0]!),
      'utf8',
    );
    expect(conflictJson).toContain('commit_style');
  });
});
