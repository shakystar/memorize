import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  listImportedRules,
} from '../../src/services/projection-store.js';
import { setupProject } from '../../src/services/setup-service.js';
import { closeAll } from '../../src/storage/db.js';
import { readEvents } from '../../src/storage/event-store.js';

let sandbox: string;
let repo: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-reimport-'));
  process.env.MEMORIZE_ROOT = join(sandbox, 'root');
  repo = join(sandbox, 'repo');
  await mkdir(repo, { recursive: true });
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('listImportedRules', () => {
  it('returns only imported-source rules from the projection', async () => {
    await writeFile(join(repo, 'CLAUDE.md'), 'rules v1\n', 'utf8');
    const { project } = await setupProject(repo);
    const imported = listImportedRules(project.id);
    expect(imported).toHaveLength(1);
    expect(imported[0]!.title).toBe('Imported CLAUDE.md');
    expect(imported[0]!.source).toBe('imported');
  });
});

describe('idempotent context re-import', () => {
  it('re-running setup with unchanged files emits no new rule events', async () => {
    await writeFile(join(repo, 'CLAUDE.md'), 'rules v1\n', 'utf8');
    const first = await setupProject(repo);
    const eventsAfterFirst = (await readEvents(first.project.id)).length;

    const second = await setupProject(repo);
    expect(second.importedContextCount).toBe(0);
    expect(listImportedRules(first.project.id)).toHaveLength(1);
    const eventsAfterSecond = (await readEvents(first.project.id)).length;
    expect(eventsAfterSecond).toBe(eventsAfterFirst);
  });

  it('changed file body upserts with the SAME rule id (no duplicates)', async () => {
    await writeFile(join(repo, 'CLAUDE.md'), 'rules v1\n', 'utf8');
    const first = await setupProject(repo);
    const originalId = listImportedRules(first.project.id)[0]!.id;

    await writeFile(join(repo, 'CLAUDE.md'), 'rules v2 — changed\n', 'utf8');
    const second = await setupProject(repo);
    expect(second.importedContextCount).toBe(1);

    const imported = listImportedRules(first.project.id);
    expect(imported).toHaveLength(1);
    expect(imported[0]!.id).toBe(originalId);
    expect(imported[0]!.body).toBe('rules v2 — changed');
  });

  it('NEVER loses data: deleting the source file keeps the existing rule, and events never shrink', async () => {
    await writeFile(join(repo, 'CLAUDE.md'), 'rules v1\n', 'utf8');
    const first = await setupProject(repo);
    const eventsBefore = (await readEvents(first.project.id)).length;

    await rm(join(repo, 'CLAUDE.md'));
    await setupProject(repo);

    const imported = listImportedRules(first.project.id);
    expect(imported).toHaveLength(1);
    expect(imported[0]!.body).toBe('rules v1');
    expect((await readEvents(first.project.id)).length).toBeGreaterThanOrEqual(
      eventsBefore,
    );
  });

  it('new file alongside an unchanged one imports only the new file', async () => {
    await writeFile(join(repo, 'CLAUDE.md'), 'rules v1\n', 'utf8');
    const first = await setupProject(repo);

    await writeFile(join(repo, 'AGENTS.md'), 'agent rules\n', 'utf8');
    const second = await setupProject(repo);
    expect(second.importedContextCount).toBe(1);
    expect(listImportedRules(first.project.id)).toHaveLength(2);
  });
});
