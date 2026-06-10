import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../src/domain/common.js';
import {
  ExtractionParseError,
  buildLifecycleEvidenceReport,
} from '../../src/services/consolidate-service.js';
import { importMemories } from '../../src/services/memory-import-service.js';
import {
  listValidMemories,
  rebuildProjectProjection,
} from '../../src/services/projection-store.js';
import { searchProject } from '../../src/services/search-service.js';
import { closeAll } from '../../src/storage/db.js';
import { appendEvent, readEvents } from '../../src/storage/event-store.js';

const projectId = 'proj_memimport_test1';
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
      title: 'Import',
      summary: 'memory import test project',
      goals: [],
      status: 'active',
      rootPath: '/tmp/import',
      activeWorkstreamIds: [],
      activeTaskIds: [],
      acceptedDecisionIds: [],
      ruleIds: [],
    } as never,
  });
  await rebuildProjectProjection(projectId);
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-import-'));
  process.env.MEMORIZE_ROOT = sandbox;
  delete process.env.MEMORIZE_LLM_API_KEY;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('importMemories (#69 agent-driven absorption primitive)', () => {
  it('ingests extractor-shaped items as first-class memories with provenance', async () => {
    await seedProject();

    const result = await importMemories({
      projectId,
      actor: 'claude',
      source: 'claude-memory',
      itemsJson: JSON.stringify([
        {
          kind: 'decision',
          text: 'The event log is the source of truth; projections are caches',
          salience: 9,
          tags: ['architecture'],
        },
        {
          kind: 'progress',
          text: 'Relay server extraction is planned but not started',
          salience: 5,
          obsoleteWhen: 'when the relay server project starts',
        },
      ]),
    });
    expect(result).toEqual({ imported: 2, skippedDuplicates: 0 });

    const memories = listValidMemories(projectId).map((row) => row.memory);
    expect(memories).toHaveLength(2);
    for (const memory of memories) {
      expect(memory.importSource).toBe('claude-memory');
      expect(memory.sourceObservationIds).toEqual([]);
    }
    const progress = memories.find((m) => m.kind === 'progress')!;
    expect(progress.obsoleteWhen).toBe('when the relay server project starts');

    // First-class: searchable + visible to the #57 evidence report.
    const hits = searchProject(projectId, 'relay server').filter(
      (hit) => hit.kind === 'memory',
    );
    expect(hits.length).toBeGreaterThan(0);
    const report = buildLifecycleEvidenceReport(projectId);
    expect(report.memories).toBe(2);
    expect(report.byKind.decision!.tags).toEqual({ architecture: 1 });
  });

  it('is idempotent: re-import (and in-batch repeats) skip kind+text duplicates', async () => {
    await seedProject();
    const items = JSON.stringify([
      { kind: 'decision', text: 'Use SQLite', salience: 8 },
      { kind: 'decision', text: '  use sqlite  ', salience: 6 }, // in-batch dup (normalized)
    ]);

    const first = await importMemories({
      projectId,
      actor: 'claude',
      source: 'docs/adr',
      itemsJson: items,
    });
    expect(first).toEqual({ imported: 1, skippedDuplicates: 1 });

    const again = await importMemories({
      projectId,
      actor: 'claude',
      source: 'docs/adr',
      itemsJson: items,
    });
    expect(again).toEqual({ imported: 0, skippedDuplicates: 2 });
    expect(listValidMemories(projectId)).toHaveLength(1);
    // Nothing was appended on the all-duplicate run.
    const types = (await readEvents(projectId)).map((e) => e.type);
    expect(types.filter((t) => t === 'memory.consolidated')).toHaveLength(1);
  });

  it('an all-invalid batch is a clean error and writes nothing', async () => {
    await seedProject();
    await expect(
      importMemories({
        projectId,
        actor: 'claude',
        source: 'docs',
        itemsJson: JSON.stringify([{ kind: 'vibe', text: 'bad' }, { kind: 'decision' }]),
      }),
    ).rejects.toThrow(ExtractionParseError);
    await expect(
      importMemories({
        projectId,
        actor: 'claude',
        source: 'docs',
        itemsJson: 'no array here',
      }),
    ).rejects.toThrow(ExtractionParseError);
    expect(listValidMemories(projectId)).toHaveLength(0);
  });

  it('requires a non-empty source label', async () => {
    await seedProject();
    await expect(
      importMemories({
        projectId,
        actor: 'claude',
        source: '   ',
        itemsJson: '[{"kind":"decision","text":"x","salience":5}]',
      }),
    ).rejects.toThrow(/--source/);
  });
});

describe('memorize memory import (CLI)', () => {
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

  it('end-to-end: bind via hook, pipe a batch, get counts; re-run skips', async () => {
    memorizeRoot = join(sandbox, '.memorize-home');
    const start = runCli(
      ['hook', 'claude', 'SessionStart'],
      JSON.stringify({
        cwd: sandbox,
        hook_event_name: 'SessionStart',
        session_id: 'import-cli-uuid-1',
      }),
    );
    expect(start.status).toBe(0);

    const batch = JSON.stringify([
      { kind: 'decision', text: 'Adopted memorize mid-project', salience: 7 },
    ]);
    const result = runCli(['memory', 'import', '--source', 'claude-memory'], batch);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      imported: 1,
      skippedDuplicates: 0,
    });

    const again = runCli(['memory', 'import', '--source', 'claude-memory'], batch);
    expect(again.status).toBe(0);
    expect(JSON.parse(again.stdout)).toEqual({
      imported: 0,
      skippedDuplicates: 1,
    });

    process.env.MEMORIZE_ROOT = memorizeRoot;
    closeAll();
    const projectDirs = await readdir(join(memorizeRoot, 'projects'));
    const events = await readEvents(projectDirs[0]!);
    const imported = events.filter((e) => e.type === 'memory.consolidated');
    expect(imported).toHaveLength(1);
    closeAll();
  });

  it('fails with usage when --source is missing or stdin is empty', async () => {
    memorizeRoot = join(sandbox, '.memorize-home');
    const noSource = runCli(['memory', 'import'], '[]');
    expect(noSource.status).toBe(1);
    expect(noSource.stderr).toContain('--source');

    const noStdin = runCli(['memory', 'import', '--source', 'x'], '');
    expect(noStdin.status).toBe(1);
    expect(noStdin.stderr).toContain('stdin');
  });
});
