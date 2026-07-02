import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderClaudeStartupContext } from '../../src/adapters/claude/renderer.js';
import { renderCodexStartupContext } from '../../src/adapters/codex/renderer.js';
import { CURRENT_SCHEMA_VERSION } from '../../src/domain/common.js';
import type { ProjectSyncState } from '../../src/domain/entities.js';
import { loadStartContext } from '../../src/services/context-service.js';
import { rebuildProjectProjection } from '../../src/services/projection-store.js';
import { closeAll } from '../../src/storage/db.js';
import { appendEvent } from '../../src/storage/event-store.js';
import { writeJson } from '../../src/storage/fs-utils.js';
import { getSyncFile } from '../../src/storage/path-resolver.js';

// W3 shared channel: a workspace-bound project surfaces OTHER members'
// memories (foreign union lanes) in `sharedMemories` — labelled by writer,
// budget-limited by its own pool, and never folded into the private
// `consolidatedMemories` truth (SoT-010/040).

const projectId = 'proj_shared_self';
const ALICE = 'proj_shared_alice';
const BOB = 'proj_shared_bob';
const ts = '2026-07-01T00:00:00.000Z';

let sandbox: string;

function memoryPayload(id: string, text: string, salience: number) {
  return {
    id,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: ts,
    updatedAt: ts,
    projectId,
    kind: 'insight',
    text,
    salience,
    sourceObservationIds: [],
  };
}

async function appendMemory(
  id: string,
  text: string,
  salience: number,
  sourceProjectId?: string,
): Promise<void> {
  await appendEvent({
    type: 'memory.consolidated',
    projectId,
    scopeType: 'project',
    scopeId: projectId,
    actor: 'test',
    ...(sourceProjectId ? { sourceProjectId } : {}),
    payload: memoryPayload(id, text, salience) as never,
  });
}

async function bindToWorkspace(): Promise<void> {
  const state: ProjectSyncState = {
    id: `sync_${projectId}`,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: ts,
    updatedAt: ts,
    projectId,
    remoteProjectId: 'wsp_shared_test1',
    workspaceRole: 'member',
    inviteReachable: true,
    syncEnabled: true,
    syncStatus: 'idle',
  };
  await writeJson(getSyncFile(projectId), state);
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-shared-'));
  process.env.MEMORIZE_ROOT = sandbox;

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
      title: 'Shared',
      summary: 'shared channel test project',
      goals: [],
      status: 'active',
      rootPath: '/tmp/shared',
      activeWorkstreamIds: [],
      activeTaskIds: [],
      acceptedDecisionIds: [],
      ruleIds: [],
    } as never,
  });
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('W3 shared memory channel', () => {
  it('surfaces foreign-lane memories grouped by writer, separate from the private pool', async () => {
    await appendMemory('mem_self', 'my own memory', 5);
    await appendMemory('mem_alice', 'alice decided X', 8, ALICE);
    await appendMemory('mem_bob', 'bob prefers Y', 6, BOB);
    await rebuildProjectProjection(projectId);
    await bindToWorkspace();

    const payload = await loadStartContext({ projectId });

    // Foreign lanes only, grouped by writer (alice sorts before bob).
    expect(payload.sharedMemories?.map((m) => [m.writer, m.id])).toEqual([
      [ALICE, 'mem_alice'],
      [BOB, 'mem_bob'],
    ]);
    // The private pool stays self-lane only — no folding either direction.
    expect(payload.consolidatedMemories?.map((m) => m.id)).toEqual(['mem_self']);

    const rendered = renderClaudeStartupContext(payload);
    expect(rendered).toContain('memorize.shared');
    expect(rendered).toContain(`From ${ALICE}:`);
    expect(rendered).toContain(`From ${BOB}:`);
    expect(rendered).toContain('alice decided X');

    const codex = renderCodexStartupContext(payload);
    expect(codex).toContain('## Workspace shared memory');
    expect(codex).toContain(`From ${BOB}:`);
  });

  it('omits the channel when the project is not workspace-bound, even with foreign lanes', async () => {
    await appendMemory('mem_alice', 'alice decided X', 8, ALICE);
    await rebuildProjectProjection(projectId);

    const payload = await loadStartContext({ projectId });
    expect(payload.sharedMemories).toBeUndefined();
    expect(renderClaudeStartupContext(payload)).not.toContain('memorize.shared');
  });

  it('omits the channel when bound but no foreign-lane memories exist', async () => {
    await appendMemory('mem_self', 'my own memory', 5);
    await rebuildProjectProjection(projectId);
    await bindToWorkspace();

    const payload = await loadStartContext({ projectId });
    expect(payload.sharedMemories).toBeUndefined();
  });

  it('fills its own char budget best-first and never exceeds it', async () => {
    // Each entry costs 500 text chars + 24 overhead against a 2000-char pool:
    // only the top 3 by salience fit; the lowest-salience entry is dropped.
    const text = (label: string) => label.padEnd(500, '.');
    await appendMemory('mem_s9', text('salience nine'), 9, ALICE);
    await appendMemory('mem_s8', text('salience eight'), 8, BOB);
    await appendMemory('mem_s7', text('salience seven'), 7, ALICE);
    await appendMemory('mem_s2', text('salience two'), 2, BOB);
    await rebuildProjectProjection(projectId);
    await bindToWorkspace();

    const payload = await loadStartContext({ projectId });
    expect(payload.sharedMemories?.map((m) => m.id).sort()).toEqual([
      'mem_s7',
      'mem_s8',
      'mem_s9',
    ]);
    const spent = payload.sharedMemories!.reduce(
      (sum, m) => sum + m.text.length + 24,
      0,
    );
    expect(spent).toBeLessThanOrEqual(2000);
  });
});
