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
import {
  acceptTaskRequest,
  declineTaskRequest,
  listMemberProjects,
  requestTask,
  resolveTargetProject,
} from '../../src/services/task-request-service.js';
import { readTask } from '../../src/services/task-service.js';
import { closeAll } from '../../src/storage/db.js';
import { appendEvent } from '../../src/storage/event-store.js';

const SELF = 'proj_svc_self';
const HUB = 'proj_svc_hub';

let sandbox: string;

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

/** Land a foreign (hub-authored) request addressed to SELF in the local union. */
async function appendInboundRequest(title: string): Promise<string> {
  const request = createTaskRequest({
    projectId: HUB,
    targetProjectId: SELF,
    title,
    goal: 'delegated goal',
    acceptanceCriteria: ['ac-1'],
  });
  // NOTE: `projectId` here names the PHYSICAL store `appendEvent` writes into
  // (`getDb(input.projectId)`); `sourceProjectId` is the provenance tag
  // `reduceProjectState`'s lane-folding actually keys off. To simulate a
  // synced-in foreign event landing in this store's own union log, this must
  // physically target SELF (like `appendGenesis` does) while stamping
  // `sourceProjectId: HUB` for provenance — NOT `projectId: HUB`, which would
  // silently write into a separate physical db that SELF's
  // `rebuildProjectProjection` never reads.
  await appendEvent({
    type: 'task.requested',
    projectId: SELF,
    scopeType: 'project',
    scopeId: request.id,
    actor: 'hub-agent',
    writer: 'hub-agent',
    sourceProjectId: HUB,
    payload: request,
  });
  await rebuildProjectProjection(SELF);
  return request.id;
}

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), 'memorize-taskreqsvc-')));
  process.env.MEMORIZE_ROOT = join(sandbox, '.memorize-home');
  await appendGenesis(SELF, 'memorize');
  await appendGenesis(HUB, 'memorize_hub');
  await rebuildProjectProjection(SELF);
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('listMemberProjects / resolveTargetProject', () => {
  it('lists both genesis projects and resolves by title, id, and fails loud', async () => {
    const members = await listMemberProjects(SELF);
    expect(members.map((m) => m.id).sort()).toEqual([HUB, SELF]);
    expect(resolveTargetProject(members, 'memorize_hub').id).toBe(HUB);
    expect(resolveTargetProject(members, 'MEMORIZE_HUB').id).toBe(HUB);
    expect(resolveTargetProject(members, HUB).id).toBe(HUB);
    expect(() => resolveTargetProject(members, 'nope')).toThrow(/No workspace member project/);
  });
});

describe('requestTask', () => {
  it('appends an outbound pending request addressed to the resolved member', async () => {
    const request = await requestTask({
      projectId: SELF,
      targetRef: 'memorize_hub',
      title: 'Add H2H endpoint',
      goal: 'ship it',
    });
    expect(request.targetProjectId).toBe(HUB);
    const outbound = await listTaskRequests(SELF, { direction: 'outbound', status: 'pending' });
    expect(outbound.map((r) => r.id)).toEqual([request.id]);
  });

  it('rejects addressing the request to this project itself', async () => {
    await expect(
      requestTask({ projectId: SELF, targetRef: 'memorize', title: 'Nope' }),
    ).rejects.toThrow(/itself/);
  });
});

describe('acceptTaskRequest', () => {
  it('mints a LOCAL task carrying the request fields and folds the accept', async () => {
    const requestId = await appendInboundRequest('Inbound work');
    const { task } = await acceptTaskRequest({ projectId: SELF, requestId });
    expect(task.title).toBe('Inbound work');
    expect(task.goal).toBe('delegated goal');
    expect(task.acceptanceCriteria).toEqual(['ac-1']);
    // The minted task is a SELF-lane task readable by the normal reader.
    expect((await readTask(SELF, task.id))?.id).toBe(task.id);
    expect((await getTaskRequest(SELF, requestId))?.status).toBe('accepted');
  });

  it('refuses to accept a request addressed to another project', async () => {
    const stray = createTaskRequest({ projectId: HUB, targetProjectId: 'proj_other', title: 'Stray' });
    await appendEvent({
      type: 'task.requested',
      projectId: SELF,
      scopeType: 'project',
      scopeId: stray.id,
      actor: 'hub-agent',
      sourceProjectId: HUB,
      payload: stray,
    });
    await rebuildProjectProjection(SELF);
    await expect(acceptTaskRequest({ projectId: SELF, requestId: stray.id })).rejects.toThrow(/addressed to/);
  });

  it('refuses a double-accept', async () => {
    const requestId = await appendInboundRequest('Once only');
    await acceptTaskRequest({ projectId: SELF, requestId });
    await expect(acceptTaskRequest({ projectId: SELF, requestId })).rejects.toThrow(/pending/);
  });
});

describe('declineTaskRequest', () => {
  it('folds the reason and requires one', async () => {
    const requestId = await appendInboundRequest('To decline');
    await declineTaskRequest({ projectId: SELF, requestId, reason: 'already done' });
    const request = await getTaskRequest(SELF, requestId);
    expect(request?.status).toBe('declined');
    expect(request?.declineReason).toBe('already done');
    await expect(
      declineTaskRequest({ projectId: SELF, requestId: 'taskreq_missing', reason: 'x' }),
    ).rejects.toThrow(/not found/);
  });
});
