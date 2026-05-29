import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeAll } from '../../src/storage/db.js';
import { appendEvent, readEventsSince } from '../../src/storage/event-store.js';

const projectId = 'proj_wm_test001';

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-watermark-'));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

async function append(label: string) {
  return appendEvent({
    type: 'task.created',
    projectId,
    scopeType: 'task',
    scopeId: `task_${label}`,
    actor: 'test',
    payload: { title: label },
  });
}

describe('readEventsSince (seq watermark)', () => {
  it('returns everything when no watermark is given', async () => {
    await append('a');
    await append('b');
    const all = await readEventsSince(projectId, undefined);
    expect(all.map((e) => e.scopeId)).toEqual(['task_a', 'task_b']);
  });

  it('returns only events strictly after the watermark id, in seq order', async () => {
    const first = await append('a');
    await append('b');
    await append('c');

    const after = await readEventsSince(projectId, first.id);
    expect(after.map((e) => e.scopeId)).toEqual(['task_b', 'task_c']);
  });

  it('returns nothing when the watermark is the last event', async () => {
    await append('a');
    const last = await append('b');
    const after = await readEventsSince(projectId, last.id);
    expect(after).toEqual([]);
  });

  it('falls back to everything when the watermark id is unknown', async () => {
    await append('a');
    await append('b');
    const after = await readEventsSince(projectId, 'evt_does_not_exist');
    expect(after.map((e) => e.scopeId)).toEqual(['task_a', 'task_b']);
  });
});
