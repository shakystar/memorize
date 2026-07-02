import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../src/domain/common.js';
import { createConsolidatedMemory } from '../../src/domain/entities.js';
import type { MemoryRetractedPayload } from '../../src/domain/entities.js';
import { importMemories } from '../../src/services/memory-import-service.js';
import { retractMemory } from '../../src/services/project-service.js';
import {
  getMemory,
  listValidMemories,
  rebuildProjectProjection,
} from '../../src/services/projection-store.js';
import { searchProject } from '../../src/services/search-service.js';
import { bindWorkspace } from '../../src/services/workspace-service.js';
import { setToken } from '../../src/storage/credentials-store.js';
import { closeAll } from '../../src/storage/db.js';
import { appendEvent, readEventsSince } from '../../src/storage/event-store.js';

const projectId = 'proj_retract_int1';
const ts = '2026-07-01T00:00:00.000Z';

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
      title: 'Retract',
      summary: 'memory retract test project',
      goals: [],
      status: 'active',
      rootPath: '/tmp/retract',
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
        text: 'Retractable: adopt znamboni indexing for the local cache',
        salience: 8,
      },
    ]),
  });
  const [row] = listValidMemories(projectId);
  return row!.memory.id;
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-retract-'));
  process.env.MEMORIZE_ROOT = sandbox;
  delete process.env.MEMORIZE_LLM_API_KEY;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('retractMemory (service, SoT-050 tombstone)', () => {
  it('drops the memory from valid reads + search but keeps the row for audit', async () => {
    await seedProject();
    const id = await seedOneMemory();

    // Present + findable before retraction.
    expect(listValidMemories(projectId).map((r) => r.memory.id)).toContain(id);
    expect(searchProject(projectId, 'znamboni').map((h) => h.entityId)).toContain(
      id,
    );

    const result = await retractMemory({
      projectId,
      memoryId: id,
      reason: 'obsolete',
    });
    expect(result).toEqual({ memoryId: id, alreadyInvalid: false });

    // Gone from valid reads and from the FTS index...
    expect(listValidMemories(projectId)).toHaveLength(0);
    expect(searchProject(projectId, 'zamboni')).toHaveLength(0);
    expect(searchProject(projectId, 'znamboni')).toHaveLength(0);

    // ...but the row + tombstone survive for audit and reversibility.
    const row = getMemory(projectId, id);
    expect(row?.memory.id).toBe(id);
    expect(row?.memory.retractedAt).toBeTruthy();
    expect(row?.memory.invalidAt).toBeTruthy();
    expect(row?.memory.text).toContain('znamboni');
  });

  it('is idempotent: retracting an already-invalid memory reports alreadyInvalid', async () => {
    await seedProject();
    const id = await seedOneMemory();

    const first = await retractMemory({ projectId, memoryId: id });
    expect(first.alreadyInvalid).toBe(false);

    const second = await retractMemory({ projectId, memoryId: id });
    expect(second.alreadyInvalid).toBe(true);
    expect(listValidMemories(projectId)).toHaveLength(0);
  });

  it('throws for an unknown memory id', async () => {
    await seedProject();
    await expect(
      retractMemory({ projectId, memoryId: 'mem_does_not_exist' }),
    ).rejects.toThrow(/not found/i);
  });
});

describe('retractMemory — owner-only GLOBAL retract (W-c, SoT-050/H030)', () => {
  const remoteUrl = 'https://hub.test';
  const wsp = 'wsp_GlobalRetract';

  /** Land a foreign writer's memory in the local store (as a union pull would). */
  async function seedForeignMemory(): Promise<string> {
    const memory = createConsolidatedMemory({
      projectId: 'proj_peer',
      kind: 'decision',
      text: 'Foreign assertion: the cache uses zorbitron eviction',
      salience: 7,
      sourceObservationIds: ['obs_peer_1'],
    });
    await appendEvent({
      type: 'memory.consolidated',
      projectId,
      scopeType: 'session',
      scopeId: projectId,
      actor: 'claude',
      writer: 'peer-claude',
      sourceProjectId: 'proj_peer',
      payload: memory as never,
    });
    await rebuildProjectProjection(projectId);
    return memory.id;
  }

  function fetchAccountWorkspaces(role: 'owner' | 'member'): typeof fetch {
    return (async (url: unknown) => {
      const target = String(url);
      if (!target.includes('/v1/account/workspaces')) {
        throw new Error(`Unexpected fetch ${target}`);
      }
      return {
        ok: true,
        status: 200,
        statusText: '',
        json: async () => ({
          workspaces: [{ workspaceId: wsp, role, inviteReachable: true }],
        }),
        text: async () => '',
      };
    }) as unknown as typeof fetch;
  }

  async function bindWithRole(role: 'owner' | 'member'): Promise<void> {
    await setToken(remoteUrl, 'tok');
    await bindWorkspace(projectId, {
      remoteUrl,
      fetchImpl: (async () => ({
        ok: true,
        status: 201,
        statusText: '',
        json: async () => ({
          workspaceId: wsp,
          eventsUrl: `/v1/projects/${wsp}/events`,
          role,
          inviteReachable: true,
        }),
        text: async () => '',
      })) as unknown as typeof fetch,
    });
  }

  it('refuses a foreign-lane target when the project is not workspace-bound', async () => {
    await seedProject();
    const id = await seedForeignMemory();
    await expect(retractMemory({ projectId, memoryId: id })).rejects.toThrow(
      /not workspace-bound/,
    );
  });

  it('refuses when the live control-plane role is member', async () => {
    await seedProject();
    const id = await seedForeignMemory();
    await bindWithRole('member');
    await expect(
      retractMemory({
        projectId,
        memoryId: id,
        fetchImpl: fetchAccountWorkspaces('member'),
      }),
    ).rejects.toThrow(/Only a workspace owner/);
  });

  it('owner: stamps writerRole on the tombstone and the projection removes the foreign memory', async () => {
    await seedProject();
    const id = await seedForeignMemory();
    await bindWithRole('owner');

    // Visible in the union read before the global retract.
    expect(
      listValidMemories(projectId, 'union').map((r) => r.memory.id),
    ).toContain(id);

    const result = await retractMemory({
      projectId,
      memoryId: id,
      reason: 'contaminated',
      fetchImpl: fetchAccountWorkspaces('owner'),
    });
    expect(result).toEqual({ memoryId: id, alreadyInvalid: false, global: true });

    // The event carries the role stamp every replica judges by.
    const retractEvent = (await readEventsSince(projectId, undefined)).find(
      (e) => e.type === 'memory.retracted',
    );
    expect((retractEvent?.payload as MemoryRetractedPayload).writerRole).toBe(
      'owner',
    );

    // Tombstoned across the union read; row survives for audit.
    expect(
      listValidMemories(projectId, 'union').map((r) => r.memory.id),
    ).not.toContain(id);
    const row = getMemory(projectId, id);
    expect(row?.memory.retractedAt).toBeTruthy();
    expect(row?.memory.sourceProjectId).toBe('proj_peer');
  });

  it('a self-lane retract still needs no workspace binding (unchanged M3 path)', async () => {
    await seedProject();
    const id = await seedOneMemory();
    const result = await retractMemory({ projectId, memoryId: id });
    expect(result).toEqual({ memoryId: id, alreadyInvalid: false });
  });
});

describe('memorize memory retract (CLI)', () => {
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

  function bindAndImport(): string {
    memorizeRoot = join(sandbox, '.memorize-home');
    const start = runCli(
      ['hook', 'claude', 'SessionStart'],
      JSON.stringify({
        cwd: sandbox,
        hook_event_name: 'SessionStart',
        session_id: 'retract-cli-uuid-1',
      }),
    );
    expect(start.status).toBe(0);

    const batch = JSON.stringify([
      {
        kind: 'decision',
        text: 'Retract me: adopt zamboni indexing for the local cache',
        salience: 8,
      },
    ]);
    const imported = runCli(
      ['memory', 'import', '--source', 'claude-memory'],
      batch,
    );
    expect(imported.status).toBe(0);

    const listed = runCli(['search', 'zamboni', '--json']);
    expect(listed.status).toBe(0);
    const hits = JSON.parse(listed.stdout) as Array<{
      entityId: string;
      kind: string;
    }>;
    const hit = hits.find((h) => h.kind === 'memory');
    expect(hit).toBeDefined();
    return hit!.entityId;
  }

  it('retracts a memory so it stops surfacing, but memory show still finds it', () => {
    const id = bindAndImport();

    const retracted = runCli(['memory', 'retract', id, '--reason', 'obsolete']);
    expect(retracted.status).toBe(0);
    const payload = JSON.parse(retracted.stdout) as {
      memoryId: string;
      alreadyInvalid: boolean;
    };
    expect(payload.memoryId).toBe(id);
    expect(payload.alreadyInvalid).toBe(false);

    // No longer in search or the valid list.
    const searched = runCli(['search', 'zamboni', '--json']);
    const hits = JSON.parse(searched.stdout) as Array<{ kind: string }>;
    expect(hits.find((h) => h.kind === 'memory')).toBeUndefined();

    const listed = runCli(['memory', 'list', '--json']);
    const rows = JSON.parse(listed.stdout) as Array<{ memory: { id: string } }>;
    expect(rows.find((r) => r.memory.id === id)).toBeUndefined();

    // But show still surfaces it, flagged retracted (auditable).
    const shown = runCli(['memory', 'show', id]);
    expect(shown.status).toBe(0);
    expect(shown.stdout).toMatch(/retracted/i);
    expect(shown.stdout).toContain('zamboni');
  });

  it('fails with usage when no id is given, and errors on an unknown id', () => {
    bindAndImport();
    const noId = runCli(['memory', 'retract']);
    expect(noId.status).toBe(1);
    expect(noId.stderr).toMatch(/id/i);

    const unknown = runCli(['memory', 'retract', 'mem_does_not_exist']);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toMatch(/not found|no memory/i);
  });
});
