import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../src/domain/common.js';
import { createObservation } from '../../src/domain/entities.js';
import {
  CONSOLIDATE_INLINE_ENV_VAR,
  spawnDetachedConsolidate,
  type DetachedSpawnImpl,
} from '../../src/services/hook-service.js';
import { closeAll } from '../../src/storage/db.js';
import { appendEvent, readEvents } from '../../src/storage/event-store.js';
import { rebuildProjectProjection } from '../../src/services/projection-store.js';

const projectId = 'proj_detached_test1';
const ts = '2026-06-10T00:00:00.000Z';

let sandbox: string;
let savedInline: string | undefined;

interface SpawnCall {
  command: string;
  args: string[];
  options: { cwd: string; detached: boolean; stdio: 'ignore' };
  unrefCalled: boolean;
}

function fakeSpawn(): { spawnImpl: DetachedSpawnImpl; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawnImpl: DetachedSpawnImpl = (command, args, options) => {
    const call: SpawnCall = { command, args, options, unrefCalled: false };
    calls.push(call);
    return {
      unref: () => {
        call.unrefCalled = true;
      },
    };
  };
  return { spawnImpl, calls };
}

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
      title: 'Detached',
      summary: 'Detached consolidate test project',
      goals: [],
      status: 'active',
      rootPath: '/tmp/detached',
      activeWorkstreamIds: [],
      activeTaskIds: [],
      acceptedDecisionIds: [],
      ruleIds: [],
    } as never,
  });
  await rebuildProjectProjection(projectId);
}

async function appendObservation(): Promise<void> {
  const observation = createObservation({
    projectId,
    signal: 'write-tool',
    sessionId: 'sess_detached_1',
    toolName: 'Write',
    summary: 'Write: /repo/detached.ts',
    filePath: '/repo/detached.ts',
  });
  await appendEvent({
    type: 'observation.captured',
    projectId,
    scopeType: 'session',
    scopeId: 'sess_detached_1',
    actor: 'claude',
    payload: observation,
  });
  await rebuildProjectProjection(projectId, { reindexSearch: false });
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-detached-'));
  process.env.MEMORIZE_ROOT = sandbox;
  savedInline = process.env[CONSOLIDATE_INLINE_ENV_VAR];
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  if (savedInline === undefined) {
    delete process.env[CONSOLIDATE_INLINE_ENV_VAR];
  } else {
    process.env[CONSOLIDATE_INLINE_ENV_VAR] = savedInline;
  }
  await rm(sandbox, { recursive: true, force: true });
});

describe('spawnDetachedConsolidate — detached mode (#46 Part A)', () => {
  beforeEach(() => {
    delete process.env[CONSOLIDATE_INLINE_ENV_VAR];
  });

  it('spawns the CLI consolidate command detached with --session and unrefs', async () => {
    const { spawnImpl, calls } = fakeSpawn();
    await spawnDetachedConsolidate(
      { projectId, agent: 'claude', cwd: sandbox },
      'sess_abc',
      spawnImpl,
    );

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.command).toBe(process.execPath);
    // argv: <cli entry> consolidate --session sess_abc
    expect(call.args[0]).toContain(`${sep}cli${sep}index.js`);
    expect(call.args.slice(1)).toEqual(['consolidate', '--session', 'sess_abc']);
    expect(call.options.cwd).toBe(sandbox);
    expect(call.options.detached).toBe(true);
    expect(call.options.stdio).toBe('ignore');
    expect(call.unrefCalled).toBe(true);
  });

  it('omits --session when no session id is known', async () => {
    const { spawnImpl, calls } = fakeSpawn();
    await spawnDetachedConsolidate(
      { projectId, agent: 'claude', cwd: sandbox },
      undefined,
      spawnImpl,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(1)).toEqual(['consolidate']);
  });

  it('does not consolidate in-process (the child owns the work)', async () => {
    await seedProject();
    await appendObservation();
    const { spawnImpl } = fakeSpawn();
    await spawnDetachedConsolidate(
      { projectId, agent: 'claude', cwd: sandbox },
      undefined,
      spawnImpl,
    );
    const types = (await readEvents(projectId)).map((e) => e.type);
    expect(types.filter((t) => t === 'memory.consolidated')).toHaveLength(0);
  });

  it('never throws when the spawn impl fails (boundary must not fail the hook)', async () => {
    const failingSpawn: DetachedSpawnImpl = () => {
      throw new Error('spawn EPERM');
    };
    await expect(
      spawnDetachedConsolidate(
        { projectId, agent: 'claude', cwd: sandbox },
        undefined,
        failingSpawn,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('spawnDetachedConsolidate — inline escape hatch (MEMORIZE_CONSOLIDATE_INLINE=1)', () => {
  beforeEach(() => {
    process.env[CONSOLIDATE_INLINE_ENV_VAR] = '1';
  });

  it('consolidates synchronously in-process and does NOT spawn', async () => {
    await seedProject();
    await appendObservation();
    const { spawnImpl, calls } = fakeSpawn();
    await spawnDetachedConsolidate(
      { projectId, agent: 'claude', cwd: sandbox },
      undefined,
      spawnImpl,
    );
    expect(calls).toHaveLength(0);
    const types = (await readEvents(projectId)).map((e) => e.type);
    expect(
      types.filter((t) => t === 'memory.consolidated').length,
    ).toBeGreaterThan(0);
  });
});
