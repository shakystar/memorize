import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../src/domain/common.js';
import {
  getSession,
  rebuildProjectProjection,
} from '../../src/services/projection-store.js';
import { searchProject } from '../../src/services/search-service.js';
import { bumpHeartbeat, startSession } from '../../src/services/session-service.js';
import { createTask } from '../../src/services/task-service.js';
import { closeAll } from '../../src/storage/db.js';
import { appendEvent } from '../../src/storage/event-store.js';

const projectId = 'proj_fts_skip_test1';
const ts = '2026-02-02T00:00:00.000Z';

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
      title: 'FTS skip',
      summary: 'fts reindex skip project',
      goals: [],
      status: 'active',
      rootPath: '/tmp/fts-skip',
      activeWorkstreamIds: [],
      activeTaskIds: [],
      acceptedDecisionIds: [],
      ruleIds: [],
    } as never,
  });
  await rebuildProjectProjection(projectId);
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-fts-skip-'));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('rebuildProjectProjection { reindexSearch: false }', () => {
  it('preserves existing FTS rows while still rebuilding projection tables', async () => {
    await seedProject();

    // (a) Searchable content: a task with a distinctive title gets indexed
    // (createTask rebuilds with the default reindexSearch:true).
    const task = await createTask({
      projectId,
      title: 'Investigate distinctivequokka deadlock',
      description: 'a distinctive marsupial keyword',
      actor: 'test',
    });
    expect(
      searchProject(projectId, 'distinctivequokka').some(
        (h) => h.entityId === task.id && h.kind === 'task',
      ),
    ).toBe(true);

    // Establish a session pointer in this cwd so bumpHeartbeat resolves.
    const sessionId = await startSession(sandbox, {
      actor: 'claude',
      projectId,
    });
    const before = getSession(projectId, sessionId);
    expect(before).toBeDefined();

    // (b) Trigger the heartbeat path (which uses reindexSearch:false).
    await bumpHeartbeat(sandbox);

    // (c) The prior FTS row must STILL be searchable — it was NOT wiped.
    expect(
      searchProject(projectId, 'distinctivequokka').some(
        (h) => h.entityId === task.id && h.kind === 'task',
      ),
    ).toBe(true);

    // (d) The projection TABLE still rebuilt: the heartbeat advanced
    // lastSeenAt on the session row, proving tables rebuild while the FTS
    // index is left intact.
    const after = getSession(projectId, sessionId);
    expect(after).toBeDefined();
    expect(Date.parse(after!.lastSeenAt)).toBeGreaterThanOrEqual(
      Date.parse(before!.lastSeenAt),
    );
  });

  it('explicit reindexSearch:false leaves a stale FTS row in place', async () => {
    await seedProject();

    const task = await createTask({
      projectId,
      title: 'Track distinctivenarwhal pipeline',
      actor: 'test',
    });
    expect(
      searchProject(projectId, 'distinctivenarwhal').length,
    ).toBeGreaterThan(0);

    // A rebuild that opts out of reindexing must not touch search_fts even
    // though it fully replaces the projection tables.
    await rebuildProjectProjection(projectId, { reindexSearch: false });
    expect(
      searchProject(projectId, 'distinctivenarwhal').some(
        (h) => h.entityId === task.id,
      ),
    ).toBe(true);

    // Sanity: a default rebuild (reindexSearch:true) keeps it findable too.
    await rebuildProjectProjection(projectId);
    expect(
      searchProject(projectId, 'distinctivenarwhal').some(
        (h) => h.entityId === task.id,
      ),
    ).toBe(true);
  });
});
