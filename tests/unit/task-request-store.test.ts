import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTaskRequest } from '../../src/domain/entities.js';
import type { Project } from '../../src/domain/entities.js';
import {
  getTaskRequest,
  listTaskRequests,
  rebuildProjectProjection,
} from '../../src/services/projection-store.js';
import { closeAll } from '../../src/storage/db.js';
import { appendEvent } from '../../src/storage/event-store.js';

const SELF = 'proj_store_self';
const HUB = 'proj_store_hub';

let sandbox: string;

/** Append a genesis for `id`; a minimal Project shape is enough to reduce. */
async function appendGenesis(id: string, title: string): Promise<void> {
  await appendEvent({
    type: 'project.created',
    projectId: SELF,
    scopeType: 'project',
    scopeId: id,
    actor: 'test',
    sourceProjectId: id,
    payload: { id, title } as unknown as Project,
  });
}

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), 'memorize-taskreq-')));
  process.env.MEMORIZE_ROOT = join(sandbox, '.memorize-home');
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('task_requests projection table', () => {
  it('persists inbound/outbound lanes and folded status', async () => {
    await appendGenesis(SELF, 'memorize');
    await appendGenesis(HUB, 'memorize_hub');

    // Inbound: authored by the hub store, addressed to self.
    const inbound = createTaskRequest({
      projectId: HUB,
      targetProjectId: SELF,
      title: 'Inbound request',
    });
    // NOTE: `projectId` here names the PHYSICAL store `appendEvent` writes
    // into (`getDb(input.projectId)`); `sourceProjectId` is the provenance
    // tag `reduceProjectState`'s lane-folding actually keys off. To simulate
    // a synced-in foreign event landing in this store's own union log, this
    // must physically target SELF (like `appendGenesis` does) while stamping
    // `sourceProjectId: HUB` for provenance — NOT `projectId: HUB`, which
    // would silently write into a separate physical db that SELF's
    // `rebuildProjectProjection` never reads.
    await appendEvent({
      type: 'task.requested',
      projectId: SELF,
      scopeType: 'project',
      scopeId: inbound.id,
      actor: 'hub-agent',
      writer: 'hub-agent',
      sourceProjectId: HUB,
      payload: inbound,
    });

    // Outbound: authored locally, addressed to the hub project.
    const outbound = createTaskRequest({
      projectId: SELF,
      targetProjectId: HUB,
      title: 'Outbound request',
    });
    await appendEvent({
      type: 'task.requested',
      projectId: SELF,
      scopeType: 'project',
      scopeId: outbound.id,
      actor: 'self-agent',
      payload: outbound,
    });

    await rebuildProjectProjection(SELF);

    const inboundRows = await listTaskRequests(SELF, { direction: 'inbound' });
    expect(inboundRows.map((r) => r.id)).toEqual([inbound.id]);
    const outboundRows = await listTaskRequests(SELF, { direction: 'outbound' });
    expect(outboundRows.map((r) => r.id)).toEqual([outbound.id]);

    // Accept the inbound one locally; the folded status must land in the table.
    await appendEvent({
      type: 'task.request-accepted',
      projectId: SELF,
      scopeType: 'project',
      scopeId: inbound.id,
      actor: 'self-agent',
      payload: { requestId: inbound.id, taskId: 'task_x' },
    });
    await rebuildProjectProjection(SELF);

    const accepted = await getTaskRequest(SELF, inbound.id);
    expect(accepted?.status).toBe('accepted');
    expect(accepted?.resolvedByTaskId).toBe('task_x');
    const pending = await listTaskRequests(SELF, { direction: 'inbound', status: 'pending' });
    expect(pending).toHaveLength(0);
  });
});
