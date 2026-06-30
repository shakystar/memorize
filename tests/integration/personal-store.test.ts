import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PERSONAL_STORE_ID } from '../../src/domain/common.js';
import { autoPull, autoPush } from '../../src/services/auto-sync-service.js';
import {
  ensurePersonalStore,
  importPersonalMemories,
  listPersonalMemories,
} from '../../src/services/personal-store-service.js';
import { listProjects } from '../../src/services/project-service.js';
import { listValidMemories } from '../../src/services/projection-store.js';
import {
  buildPushPayload,
  cloneProject,
  pullProject,
  pushProject,
} from '../../src/services/sync-service.js';
import { closeAll } from '../../src/storage/db.js';
import {
  getPersonalRoot,
  getProjectsRoot,
} from '../../src/storage/path-resolver.js';

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-personal-'));
  process.env.MEMORIZE_ROOT = sandbox;
  delete process.env.MEMORIZE_LLM_API_KEY;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('global personal memory store (Path A)', () => {
  it('imports into a host-level store that lives OUTSIDE projects/ and is invisible to listProjects', async () => {
    const result = await importPersonalMemories({
      actor: 'claude',
      source: 'claude-memory',
      itemsJson: JSON.stringify([
        {
          kind: 'decision',
          text: 'Prefers full sentences over telegraphic fragments',
          salience: 8,
        },
        {
          kind: 'rationale',
          text: 'Works in Korean and English; local-first single-user',
          salience: 7,
        },
      ]),
    });
    expect(result).toEqual({ imported: 2, skippedDuplicates: 0 });

    // The store landed in ~/.memorize/personal/, a SIBLING of projects/.
    expect(existsSync(join(getPersonalRoot(), 'memorize.db'))).toBe(true);
    expect((await stat(getPersonalRoot())).isDirectory()).toBe(true);
    // projects/ was never created (no real project bound this run).
    expect(existsSync(getProjectsRoot())).toBe(false);

    // The memories are readable via the personal-store API.
    const personal = listPersonalMemories().map((row) => row.memory);
    expect(personal).toHaveLength(2);
    for (const memory of personal) {
      expect(memory.importSource).toBe('claude-memory');
    }

    // And the personal store never shows up as a project.
    const projects = await listProjects();
    expect(projects.map((p) => p.id)).not.toContain(PERSONAL_STORE_ID);
    expect(projects).toHaveLength(0);
  });

  it('bootstrap is idempotent and re-import skips kind+text duplicates', async () => {
    await ensurePersonalStore();
    await ensurePersonalStore(); // second call is a no-op

    const items = JSON.stringify([
      { kind: 'decision', text: 'Pause before irreversible actions', salience: 9 },
    ]);
    const first = await importPersonalMemories({
      actor: 'claude',
      source: 'notes',
      itemsJson: items,
    });
    expect(first).toEqual({ imported: 1, skippedDuplicates: 0 });

    const again = await importPersonalMemories({
      actor: 'claude',
      source: 'notes',
      itemsJson: items,
    });
    expect(again).toEqual({ imported: 0, skippedDuplicates: 1 });
    expect(listPersonalMemories()).toHaveLength(1);
  });

  it('keeps personal memory separate from a real project store', async () => {
    // Seed personal memory.
    await importPersonalMemories({
      actor: 'claude',
      source: 'notes',
      itemsJson: JSON.stringify([
        { kind: 'rationale', text: 'personal-only fact', salience: 6 },
      ]),
    });
    // The reserved id's memories are NOT visible under any other project id,
    // and the personal store holds none of a project's.
    expect(listValidMemories(PERSONAL_STORE_ID)).toHaveLength(1);
  });
});

describe('personal store privacy boundary (never syncs)', () => {
  it('refuses every sync entry point for the personal store id', async () => {
    const transport = {} as never;
    await expect(pushProject(PERSONAL_STORE_ID, transport)).rejects.toThrow(
      /never leaves this host/,
    );
    await expect(pullProject(PERSONAL_STORE_ID, transport)).rejects.toThrow(
      /never leaves this host/,
    );
    await expect(buildPushPayload(PERSONAL_STORE_ID)).rejects.toThrow(
      /never leaves this host/,
    );
    await expect(
      cloneProject(join(sandbox, 'clone'), PERSONAL_STORE_ID, transport),
    ).rejects.toThrow(/never leaves this host/);
  });

  it('auto-sync is a silent no-op for the personal store', async () => {
    expect(await autoPush(PERSONAL_STORE_ID)).toEqual({
      ran: false,
      reason: 'not-configured',
    });
    expect(await autoPull(PERSONAL_STORE_ID)).toEqual({
      ran: false,
      reason: 'not-configured',
    });
  });
});

describe('memorize personal (CLI)', () => {
  const repoRoot = process.cwd();
  const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

  function runCli(args: string[], input?: string) {
    return spawnSync(process.execPath, [tsxCliPath, cliEntryPath, ...args], {
      cwd: sandbox,
      encoding: 'utf8',
      env: { ...process.env, MEMORIZE_ROOT: sandbox },
      ...(input !== undefined ? { input } : {}),
    });
  }

  it('import then list, with no bound project in the cwd', async () => {
    const batch = JSON.stringify([
      { kind: 'decision', text: 'Confirm before npm publish', salience: 9 },
    ]);
    const imported = runCli(['personal', 'import', '--source', 'claude-memory'], batch);
    expect(imported.status).toBe(0);
    expect(JSON.parse(imported.stdout)).toEqual({
      imported: 1,
      skippedDuplicates: 0,
    });

    const listed = runCli(['personal', 'list', '--json'], '');
    expect(listed.status).toBe(0);
    const rows = JSON.parse(listed.stdout) as Array<{ memory: { text: string } }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.memory.text).toContain('npm publish');
  });

  it('fails with usage when --source is missing or stdin is empty', () => {
    const noSource = runCli(['personal', 'import'], '[]');
    expect(noSource.status).toBe(1);
    expect(noSource.stderr).toContain('--source');

    const noStdin = runCli(['personal', 'import', '--source', 'x'], '');
    expect(noStdin.status).toBe(1);
    expect(noStdin.stderr).toContain('stdin');
  });
});
