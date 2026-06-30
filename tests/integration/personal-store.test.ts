import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderClaudeStartupContext } from '../../src/adapters/claude/renderer.js';
import { CURRENT_SCHEMA_VERSION, PERSONAL_STORE_ID } from '../../src/domain/common.js';
import { createObservation } from '../../src/domain/entities.js';
import { autoPull, autoPush } from '../../src/services/auto-sync-service.js';
import { loadStartContext } from '../../src/services/context-service.js';
import {
  type Consolidator,
  consolidate,
} from '../../src/services/consolidate-service.js';
import { rebuildProjectProjection } from '../../src/services/projection-store.js';
import { appendEvent } from '../../src/storage/event-store.js';
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

describe('auto-classification routing (consolidation → personal store)', () => {
  const projectId = 'proj_route_test1';
  const ts = '2026-06-30T00:00:00.000Z';

  async function seedProjectWithObservation(): Promise<void> {
    await appendEvent({
      type: 'project.created',
      projectId,
      scopeType: 'project',
      scopeId: projectId,
      actor: 'test',
      payload: {
        id: projectId,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        createdAt: ts,
        updatedAt: ts,
        title: 'Route',
        summary: 'routing test project',
        goals: [],
        status: 'active',
        rootPath: '/tmp/route',
        activeWorkstreamIds: [],
        activeTaskIds: [],
        acceptedDecisionIds: [],
        ruleIds: [],
      } as never,
    });
    // One observation so consolidate() does not no-op before extraction.
    const observation = createObservation({
      projectId,
      signal: 'mutating-bash',
      toolName: 'Bash',
      summary: 'git commit -m wip',
    });
    await appendEvent({
      type: 'observation.captured',
      projectId,
      scopeType: 'session',
      scopeId: projectId,
      actor: 'test',
      payload: observation,
    });
    await rebuildProjectProjection(projectId);
  }

  // Extractor that classifies one item personal, one project — ignores input.
  const mixed: Consolidator = {
    async extract() {
      return [
        { kind: 'progress' as const, text: 'project: wired the auth module', salience: 5 },
        {
          kind: 'decision' as const,
          text: 'user prefers full sentences over fragments',
          salience: 8,
          personal: true,
        },
      ];
    },
  };

  it('routes personal items to the personal store and project items to the project store', async () => {
    await seedProjectWithObservation();

    const result = await consolidate({
      projectId,
      actor: 'test',
      consolidator: mixed,
    });
    expect(result.consolidated).toBe(1); // project memories only
    expect(result.personalConsolidated).toBe(1);

    const projectMemories = listValidMemories(projectId).map((r) => r.memory);
    expect(projectMemories).toHaveLength(1);
    expect(projectMemories[0]!.text).toContain('auth module');

    const personalMemories = listPersonalMemories().map((r) => r.memory);
    expect(personalMemories).toHaveLength(1);
    expect(personalMemories[0]!.text).toContain('full sentences');
    // Routed (not imported): consolidation provenance, not an import source.
    expect(personalMemories[0]!.importSource).toBeUndefined();
    expect(personalMemories[0]!.sourceObservationIds.length).toBeGreaterThan(0);
  });

  it('routePersonal:false keeps every item in the project store (benchmark path)', async () => {
    await seedProjectWithObservation();

    const result = await consolidate({
      projectId,
      actor: 'test',
      consolidator: mixed,
      routePersonal: false,
    });
    expect(result.consolidated).toBe(2);
    expect(result.personalConsolidated).toBeUndefined();

    expect(listValidMemories(projectId)).toHaveLength(2);
    // The personal store was never even created.
    expect(existsSync(join(getPersonalRoot(), 'memorize.db'))).toBe(false);
  });
});

describe('startup injection (dedicated personal channel)', () => {
  const projectId = 'proj_inject_test1';
  const ts = '2026-06-30T00:00:00.000Z';

  async function seedProject(): Promise<void> {
    await appendEvent({
      type: 'project.created',
      projectId,
      scopeType: 'project',
      scopeId: projectId,
      actor: 'test',
      payload: {
        id: projectId,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        createdAt: ts,
        updatedAt: ts,
        title: 'Inject',
        summary: 'injection test project',
        goals: [],
        status: 'active',
        rootPath: '/tmp/inject',
        activeWorkstreamIds: [],
        activeTaskIds: [],
        acceptedDecisionIds: [],
        ruleIds: [],
      } as never,
    });
    await rebuildProjectProjection(projectId);
  }

  it('surfaces personal memory in its own channel, separate from the project pool', async () => {
    await seedProject();
    await importPersonalMemories({
      actor: 'claude',
      source: 'notes',
      itemsJson: JSON.stringify([
        { kind: 'decision', text: 'user prefers full sentences', salience: 9 },
      ]),
    });

    const payload = await loadStartContext({ projectId });
    expect(payload.personalMemories?.map((m) => m.text)).toContain(
      'user prefers full sentences',
    );
    // Not mixed into the project memory pool (which is empty here).
    expect(payload.consolidatedMemories ?? []).toHaveLength(0);

    const rendered = renderClaudeStartupContext(payload);
    expect(rendered).toContain('Personal memory (cross-project');
    expect(rendered).toContain('full sentences');
    expect(rendered).toContain('memorize.personal');
  });

  it('omits the personal channel entirely when no personal store exists', async () => {
    await seedProject();
    const payload = await loadStartContext({ projectId });
    expect(payload.personalMemories).toBeUndefined();
    // And the personal store was not materialized just by loading startup context.
    expect(existsSync(join(getPersonalRoot(), 'memorize.db'))).toBe(false);
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
