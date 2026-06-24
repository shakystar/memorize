import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProject } from '../../src/services/project-service.js';
import { importContextFiles } from '../../src/services/setup-service.js';
import { resolveConflict } from '../../src/services/conflict-service.js';
import {
  getConflict,
  listOpenConflicts,
} from '../../src/services/projection-store.js';
import { closeAll } from '../../src/storage/db.js';

let sandbox: string;
let previousMemorizeRoot: string | undefined;

beforeEach(async () => {
  // os.tmpdir() is a symlink on macOS (/var -> /private/var); canonicalize so
  // any path-derived keys agree. Mirrors setup-relocate-detect.test.ts.
  sandbox = await realpath(await mkdtemp(join(tmpdir(), 'memorize-conflict-rebuild-')));
  previousMemorizeRoot = process.env.MEMORIZE_ROOT;
  process.env.MEMORIZE_ROOT = join(sandbox, '.memorize-home');
});

afterEach(async () => {
  if (previousMemorizeRoot === undefined) delete process.env.MEMORIZE_ROOT;
  else process.env.MEMORIZE_ROOT = previousMemorizeRoot;
  closeAll();
  await rm(sandbox, { recursive: true, force: true });
});

describe('conflict resolve rebuild (#157)', () => {
  // Drives the real setup-service conflict.detected producer: a CLAUDE.md whose
  // rules say both "keep commits small" and "squash" mints the commit-style rule
  // conflict. The projector keys state.conflicts by the EVENT scopeId, while
  // conflict.resolved always uses scopeId=conflict.id. If the producer emits the
  // detected event with scopeId=projectId, the same conflict.id lands under two
  // Record keys on rebuild and the conflicts INSERT collides on its primary key.
  it('resolves a setup-minted commit-style conflict without a UNIQUE collision', async () => {
    await writeFile(
      join(sandbox, 'CLAUDE.md'),
      '# Rules\n\nAlways keep commits small.\n\nAlways squash into one final commit.\n',
    );

    const project = await createProject({
      title: 'Conflict rebuild',
      rootPath: sandbox,
    });

    await importContextFiles(project);

    const open = listOpenConflicts(project.id);
    expect(open).toHaveLength(1);
    const conflictId = open[0]!.id;

    // Before the fix this throws "UNIQUE constraint failed: conflicts.id"
    // during rebuildProjectProjection inside resolveConflict.
    await resolveConflict(project.id, conflictId, {
      actor: 'user',
      summary: 'kept small commits',
    });

    const stored = getConflict(project.id, conflictId);
    expect(stored?.status).toBe('resolved');
    // Exactly one conflicts row survives the detected -> resolved replay.
    expect(listOpenConflicts(project.id)).toHaveLength(0);
  });
});
