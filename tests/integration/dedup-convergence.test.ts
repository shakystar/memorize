import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFileSyncTransport } from '../../src/adapters/sync-transport-file.js';
import {
  createConsolidatedMemory,
  createObservation,
} from '../../src/domain/entities.js';
import { createProject } from '../../src/services/project-service.js';
import {
  listValidMemories,
  rebuildProjectProjection,
} from '../../src/services/projection-store.js';
import { retrieveMemoryContext } from '../../src/services/memory-retrieval-service.js';
import { searchProject } from '../../src/services/search-service.js';
import { cloneProject, pullProject, pushProject } from '../../src/services/sync-service.js';
import { closeAll, getDb } from '../../src/storage/db.js';
import { appendEvent } from '../../src/storage/event-store.js';

let sandbox: string;

const tsEarly = '2026-06-08T00:00:00.000Z';
const tsLate = '2026-06-08T01:00:00.000Z';

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-dedup-'));
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

// True replicas share a projectId; getDb caches by projectId ignoring root, so
// drop the cache on each "machine" switch (real separate processes get this).
function useMachine(root: string): void {
  closeAll();
  process.env.MEMORIZE_ROOT = root;
}

async function appendObservation(projectId: string, filePath: string) {
  const obs = createObservation({
    projectId,
    signal: 'write-tool',
    toolName: 'Write',
    summary: `Write: ${filePath}`,
    filePath,
  });
  await appendEvent({
    type: 'observation.captured',
    projectId,
    scopeType: 'session',
    scopeId: projectId,
    actor: 'claude',
    payload: obs,
  });
  return obs;
}

async function appendMemory(
  projectId: string,
  createdAt: string,
  sourceObservationIds: string[],
  text: string,
) {
  const memory = {
    ...createConsolidatedMemory({
      projectId,
      kind: 'progress' as const,
      text,
      salience: 5,
      sourceObservationIds,
    }),
    createdAt,
  };
  await appendEvent({
    type: 'memory.consolidated',
    projectId,
    scopeType: 'session',
    scopeId: projectId,
    actor: 'claude',
    payload: memory,
  });
  return memory;
}

describe('cross-machine memory dedup — convergence (P3-a)', () => {
  it('concurrent consolidation of the same window converges to one deterministic winner', async () => {
    const remotePath = join(sandbox, 'remote');
    const homeA = join(sandbox, 'home-a');
    const homeB = join(sandbox, 'home-b');
    const transport = createFileSyncTransport(remotePath);

    // A: create project, capture obs, push.
    useMachine(homeA);
    const projectA = await createProject({ title: 'A', rootPath: join(sandbox, 'a') });
    const obs = await appendObservation(projectA.id, '/repo/x.ts');
    await pushProject(projectA.id, transport);

    // B: clone (gets project + obs, NO memory yet).
    useMachine(homeB);
    await cloneProject(join(sandbox, 'b'), projectA.id, transport);

    // RACE: A and B each consolidate the SAME obs window before syncing.
    useMachine(homeA);
    const memA = await appendMemory(projectA.id, tsEarly, [obs.id], 'A view');
    await pushProject(projectA.id, transport);

    useMachine(homeB);
    const memB = await appendMemory(projectA.id, tsLate, [obs.id], 'B view');
    await pushProject(projectA.id, transport);
    await pullProject(projectA.id, transport); // B gets memA

    useMachine(homeA);
    await pullProject(projectA.id, transport); // A gets memB

    // Converge on A: one valid memory, the (createdAt,id)-min winner = memA.
    const validA = listValidMemories(projectA.id);
    expect(validA).toHaveLength(1);
    expect(validA[0]!.memory.id).toBe(memA.id);

    // Converge on B identically (sync order differed: B pulled memA last,
    // A pulled memB last — same winner proves order independence).
    useMachine(homeB);
    const validB = listValidMemories(projectA.id);
    expect(validB).toHaveLength(1);
    expect(validB[0]!.memory.id).toBe(memA.id);

    // Loser row: marked deduped_by winner + invalid_at set.
    const loserRow = getDb(projectA.id)
      .prepare('SELECT deduped_by, invalid_at FROM memories WHERE id = ?')
      .get(memB.id) as { deduped_by: string | null; invalid_at: string | null };
    expect(loserRow.deduped_by).toBe(memA.id);
    expect(loserRow.invalid_at).toBeTruthy();

    // Search + retrieval converge to the single winner too.
    expect(searchProject(projectA.id, 'view')).toHaveLength(1);
    expect(retrieveMemoryContext(projectA.id, {}).memories).toHaveLength(1);
  });

  it('single machine (no duplicates) is unchanged — loser marker stays null', async () => {
    useMachine(join(sandbox, 'home-a'));
    const project = await createProject({ title: 'A', rootPath: join(sandbox, 'a') });
    const obs = await appendObservation(project.id, '/repo/x.ts');
    const memory = await appendMemory(project.id, tsEarly, [obs.id], 'only');
    await rebuildProjectProjection(project.id);

    const valid = listValidMemories(project.id);
    expect(valid).toHaveLength(1);
    const row = getDb(project.id)
      .prepare('SELECT deduped_by FROM memories WHERE id = ?')
      .get(memory.id) as { deduped_by: string | null };
    expect(row.deduped_by).toBeNull();
  });

  it('memories with empty sourceObservationIds are never grouped', async () => {
    useMachine(join(sandbox, 'home-a'));
    const project = await createProject({ title: 'A', rootPath: join(sandbox, 'a') });
    await appendMemory(project.id, tsEarly, [], 'orphan one');
    await appendMemory(project.id, tsLate, [], 'orphan two');
    await rebuildProjectProjection(project.id);

    expect(listValidMemories(project.id)).toHaveLength(2);
  });
});
