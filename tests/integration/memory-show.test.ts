import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../src/domain/common.js';
import { importMemories } from '../../src/services/memory-import-service.js';
import {
  getMemory,
  listValidMemories,
  rebuildProjectProjection,
} from '../../src/services/projection-store.js';
import { closeAll } from '../../src/storage/db.js';
import { appendEvent } from '../../src/storage/event-store.js';

const projectId = 'proj_memshow_test1';
const ts = '2026-06-10T00:00:00.000Z';

let sandbox: string;

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
      title: 'Show',
      summary: 'memory show test project',
      goals: [],
      status: 'active',
      rootPath: '/tmp/show',
      activeWorkstreamIds: [],
      activeTaskIds: [],
      acceptedDecisionIds: [],
      ruleIds: [],
    } as never,
  });
  await rebuildProjectProjection(projectId);
}

async function seedOneMemory(): Promise<string> {
  await importMemories({
    projectId,
    actor: 'claude',
    source: 'claude-memory',
    itemsJson: JSON.stringify([
      {
        kind: 'decision',
        text: 'The event log is the single source of truth; projections are caches',
        salience: 9,
        tags: ['architecture'],
        obsoleteWhen: 'when projections become authoritative',
      },
    ]),
  });
  const [row] = listValidMemories(projectId);
  return row!.memory.id;
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-show-'));
  process.env.MEMORIZE_ROOT = sandbox;
  delete process.env.MEMORIZE_LLM_API_KEY;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('getMemory (single-memory reader)', () => {
  it('returns the full memory record by id, undefined for an unknown id', async () => {
    await seedProject();
    const id = await seedOneMemory();

    const found = getMemory(projectId, id);
    expect(found?.memory.id).toBe(id);
    expect(found?.memory.text).toContain('single source of truth');
    expect(found?.memory.kind).toBe('decision');
    expect(found?.memory.salience).toBe(9);
    expect(found?.memory.importSource).toBe('claude-memory');

    expect(getMemory(projectId, 'mem_does_not_exist')).toBeUndefined();
  });
});

describe('memorize memory show (CLI)', () => {
  const repoRoot = process.cwd();
  const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');
  let memorizeRoot: string;

  function runCli(args: string[], input?: string) {
    return spawnSync(process.execPath, [tsxCliPath, cliEntryPath, ...args], {
      cwd: sandbox,
      encoding: 'utf8',
      env: { ...process.env, MEMORIZE_ROOT: memorizeRoot },
      ...(input !== undefined ? { input } : {}),
    });
  }

  /** Bind cwd to a project, import one memory, return its id. */
  function bindAndImport(): string {
    memorizeRoot = join(sandbox, '.memorize-home');
    const start = runCli(
      ['hook', 'claude', 'SessionStart'],
      JSON.stringify({
        cwd: sandbox,
        hook_event_name: 'SessionStart',
        session_id: 'show-cli-uuid-1',
      }),
    );
    expect(start.status).toBe(0);

    const batch = JSON.stringify([
      {
        kind: 'decision',
        text: 'Adopt SQLite + FTS5 for the local index',
        salience: 8,
        tags: ['storage'],
        obsoleteWhen: 'when a server-side index is introduced',
      },
    ]);
    const imported = runCli(['memory', 'import', '--source', 'claude-memory'], batch);
    expect(imported.status).toBe(0);

    const listed = runCli(['search', 'SQLite', '--json']);
    expect(listed.status).toBe(0);
    const hits = JSON.parse(listed.stdout) as Array<{
      entityId: string;
      kind: string;
    }>;
    const hit = hits.find((h) => h.kind === 'memory');
    expect(hit).toBeDefined();
    return hit!.entityId;
  }

  it('prints the full text + metadata (human) for a known id', () => {
    const id = bindAndImport();
    const result = runCli(['memory', 'show', id]);
    expect(result.status).toBe(0);
    // Full text, not a truncated snippet.
    expect(result.stdout).toContain('Adopt SQLite + FTS5 for the local index');
    // Metadata fields.
    expect(result.stdout).toContain(id);
    expect(result.stdout).toMatch(/decision/);
    expect(result.stdout).toMatch(/salience/i);
    expect(result.stdout).toContain('claude-memory');
    expect(result.stdout).toContain('when a server-side index is introduced');
  });

  it('--json returns the structured record with real fields', () => {
    const id = bindAndImport();
    const result = runCli(['memory', 'show', id, '--json']);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      memory: {
        id: string;
        kind: string;
        text: string;
        salience: number;
        importSource?: string;
        obsoleteWhen?: string;
        tags?: string[];
        sourceObservationIds: string[];
      };
      lastAccessedAt?: string;
    };
    expect(payload.memory.id).toBe(id);
    expect(payload.memory.kind).toBe('decision');
    expect(payload.memory.text).toBe('Adopt SQLite + FTS5 for the local index');
    expect(payload.memory.salience).toBe(8);
    expect(payload.memory.importSource).toBe('claude-memory');
    expect(payload.memory.obsoleteWhen).toBe(
      'when a server-side index is introduced',
    );
    expect(payload.memory.tags).toEqual(['storage']);
    expect(payload.memory.sourceObservationIds).toEqual([]);
  });

  it('fails with a clear error and non-zero exit for an unknown id', () => {
    bindAndImport();
    const result = runCli(['memory', 'show', 'mem_does_not_exist']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/mem_does_not_exist/);
    expect(result.stderr).toMatch(/not found|no memory/i);
  });

  it('fails with usage when no id is given', () => {
    bindAndImport();
    const result = runCli(['memory', 'show']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/id/i);
  });
});
