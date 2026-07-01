import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../src/domain/common.js';
import {
  createConsolidatedMemory,
  createObservation,
} from '../../src/domain/entities.js';
import type { ProjectSyncState } from '../../src/domain/entities.js';
import {
  getConsolidateWatermark,
  setConsolidateWatermark,
} from '../../src/services/consolidate-service.js';
import { gcUnpushedRetracted } from '../../src/services/gc-service.js';
import { retractMemory } from '../../src/services/project-service.js';
import {
  getMemory,
  listValidMemories,
  rebuildProjectProjection,
} from '../../src/services/projection-store.js';
import { closeAll } from '../../src/storage/db.js';
import { appendEvent, readEvents } from '../../src/storage/event-store.js';
import { writeJson } from '../../src/storage/fs-utils.js';
import { getSyncFile } from '../../src/storage/path-resolver.js';

const projectId = 'proj_gc_test1';
const ts = '2026-07-01T00:00:00.000Z';

let sandbox: string;

async function seedProject(): Promise<string> {
  const ev = await appendEvent({
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
      title: 'GC',
      summary: 'memory gc test project',
      goals: [],
      status: 'active',
      rootPath: '/tmp/gc',
      activeWorkstreamIds: [],
      activeTaskIds: [],
      acceptedDecisionIds: [],
      ruleIds: [],
    } as never,
  });
  await rebuildProjectProjection(projectId);
  return ev.id;
}

async function addObs(): Promise<{ obsId: string; eventId: string }> {
  const obs = createObservation({
    projectId,
    signal: 'write-tool',
    summary: 'obs',
  });
  const ev = await appendEvent({
    type: 'observation.captured',
    projectId,
    scopeType: 'session',
    scopeId: projectId,
    actor: 'test',
    payload: obs,
  });
  return { obsId: obs.id, eventId: ev.id };
}

async function addMemory(
  text: string,
  sourceObs: string[] = [],
): Promise<{ memId: string; eventId: string }> {
  const mem = createConsolidatedMemory({
    projectId,
    kind: 'decision',
    text,
    salience: 7,
    sourceObservationIds: sourceObs,
  });
  const ev = await appendEvent({
    type: 'memory.consolidated',
    projectId,
    scopeType: 'session',
    scopeId: projectId,
    actor: 'test',
    payload: mem,
  });
  return { memId: mem.id, eventId: ev.id };
}

/** Write a minimal sync state marking events up to `eventId` as pushed/shared. */
async function markPushedThrough(eventId: string): Promise<void> {
  const state: ProjectSyncState = {
    id: `sync_${projectId}`,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: ts,
    updatedAt: ts,
    projectId,
    syncEnabled: true,
    syncStatus: 'idle',
    lastPushedEventId: eventId,
  };
  await writeJson(getSyncFile(projectId), state);
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-gc-'));
  process.env.MEMORIZE_ROOT = sandbox;
  delete process.env.MEMORIZE_LLM_API_KEY;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('gcUnpushedRetracted (M3-b, SoT-050 physical reclamation)', () => {
  it('reclaims an un-pushed retracted memory (events physically deleted)', async () => {
    await seedProject();
    const { memId } = await addMemory('reclaim me');
    await rebuildProjectProjection(projectId);
    await retractMemory({ projectId, memoryId: memId });

    const before = (await readEvents(projectId)).length;
    const result = await gcUnpushedRetracted(projectId);

    expect(result.reclaimedMemories).toEqual([memId]);
    expect(result.reclaimedEvents).toBe(2); // consolidated + retracted
    expect(result.skippedShared).toBe(0);
    // Events physically gone.
    expect((await readEvents(projectId)).length).toBe(before - 2);
    // Row gone entirely (unlike retract, which keeps it for `show`).
    expect(getMemory(projectId, memId)).toBeUndefined();
    expect(listValidMemories(projectId)).toHaveLength(0);
  });

  it('leaves a SHARED (pushed) retracted memory as a tombstone', async () => {
    await seedProject();
    const { memId, eventId } = await addMemory('shared, do not delete');
    await rebuildProjectProjection(projectId);
    // Mark the consolidated event as already pushed → shared.
    await markPushedThrough(eventId);
    await retractMemory({ projectId, memoryId: memId });

    const before = (await readEvents(projectId)).length;
    const result = await gcUnpushedRetracted(projectId);

    expect(result.reclaimedMemories).toHaveLength(0);
    expect(result.skippedShared).toBe(1);
    expect((await readEvents(projectId)).length).toBe(before); // nothing deleted
    // Still present, flagged retracted (M3-a tombstone).
    const row = getMemory(projectId, memId);
    expect(row?.memory.retractedAt).toBeTruthy();
  });

  it('deletes an exclusively-owned un-pushed source observation (revival-free)', async () => {
    await seedProject();
    const { obsId, eventId: obsEventId } = await addObs();
    const { memId } = await addMemory('derived from obs', [obsId]);
    await rebuildProjectProjection(projectId);
    await retractMemory({ projectId, memoryId: memId });

    const result = await gcUnpushedRetracted(projectId);

    expect(result.reclaimedMemories).toEqual([memId]);
    expect(result.reclaimedObservations).toBe(1);
    // The observation event is physically gone, so nothing can re-derive it.
    const ids = new Set((await readEvents(projectId)).map((e) => e.id));
    expect(ids.has(obsEventId)).toBe(false);
  });

  it('keeps a source observation still referenced by a SURVIVING memory', async () => {
    await seedProject();
    const { obsId, eventId: obsEventId } = await addObs();
    const { memId: retractMe } = await addMemory('to retract', [obsId]);
    await addMemory('survivor sharing the obs', [obsId]);
    await rebuildProjectProjection(projectId);
    await retractMemory({ projectId, memoryId: retractMe });

    const result = await gcUnpushedRetracted(projectId);

    expect(result.reclaimedMemories).toEqual([retractMe]);
    // Observation kept — the survivor still needs it and shields re-derivation.
    expect(result.reclaimedObservations).toBe(0);
    const ids = new Set((await readEvents(projectId)).map((e) => e.id));
    expect(ids.has(obsEventId)).toBe(true);
    expect(listValidMemories(projectId)).toHaveLength(1); // survivor stays
  });

  it('--dry-run reports without mutating', async () => {
    await seedProject();
    const { memId } = await addMemory('dry run me');
    await rebuildProjectProjection(projectId);
    await retractMemory({ projectId, memoryId: memId });

    const before = (await readEvents(projectId)).length;
    const result = await gcUnpushedRetracted(projectId, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.reclaimedMemories).toEqual([memId]);
    expect((await readEvents(projectId)).length).toBe(before); // untouched
    expect(getMemory(projectId, memId)).toBeTruthy(); // still there
  });

  it('repairs the consolidation watermark when it points at a deleted observation', async () => {
    const projectCreatedId = await seedProject();
    const { obsId, eventId: obsEventId } = await addObs();
    const { memId } = await addMemory('watermark obs memory', [obsId]);
    await rebuildProjectProjection(projectId);
    await retractMemory({ projectId, memoryId: memId });
    // Pretend consolidation had consumed up through this observation.
    setConsolidateWatermark(projectId, obsEventId);

    await gcUnpushedRetracted(projectId);

    const wm = getConsolidateWatermark(projectId);
    // Not the deleted obs anymore; repaired to a surviving earlier event.
    expect(wm).not.toBe(obsEventId);
    expect(wm).toBe(projectCreatedId);
    const ids = new Set((await readEvents(projectId)).map((e) => e.id));
    expect(ids.has(wm!)).toBe(true);
  });
});

describe('memorize memory gc (CLI)', () => {
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

  function bindImportRetract(): string {
    memorizeRoot = join(sandbox, '.memorize-home');
    const start = runCli(
      ['hook', 'claude', 'SessionStart'],
      JSON.stringify({
        cwd: sandbox,
        hook_event_name: 'SessionStart',
        session_id: 'gc-cli-uuid-1',
      }),
    );
    expect(start.status).toBe(0);
    const imported = runCli(
      ['memory', 'import', '--source', 'claude-memory'],
      JSON.stringify([
        { kind: 'decision', text: 'GC me: adopt xylophone indexing', salience: 8 },
      ]),
    );
    expect(imported.status).toBe(0);
    const hits = JSON.parse(runCli(['search', 'xylophone', '--json']).stdout) as Array<{
      entityId: string;
      kind: string;
    }>;
    const id = hits.find((h) => h.kind === 'memory')!.entityId;
    expect(runCli(['memory', 'retract', id]).status).toBe(0);
    return id;
  }

  it('dry-run leaves the memory; real gc physically removes it', () => {
    const id = bindImportRetract();

    const dry = runCli(['memory', 'gc', '--dry-run', '--json']);
    expect(dry.status).toBe(0);
    const dryResult = JSON.parse(dry.stdout) as {
      reclaimedMemories: string[];
      dryRun: boolean;
    };
    expect(dryResult.dryRun).toBe(true);
    expect(dryResult.reclaimedMemories).toContain(id);
    // Dry run mutated nothing: show still finds the tombstoned memory.
    expect(runCli(['memory', 'show', id]).status).toBe(0);

    const gc = runCli(['memory', 'gc', '--json']);
    expect(gc.status).toBe(0);
    const gcResult = JSON.parse(gc.stdout) as { reclaimedMemories: string[] };
    expect(gcResult.reclaimedMemories).toContain(id);
    // After gc the events are gone → show can no longer find it.
    const shown = runCli(['memory', 'show', id]);
    expect(shown.status).toBe(1);
    expect(shown.stderr).toMatch(/not found|no memory/i);
  });
});
