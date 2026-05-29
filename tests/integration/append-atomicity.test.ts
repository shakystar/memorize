import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProject } from '../../src/services/project-service.js';
import { closeAll } from '../../src/storage/db.js';
import { appendEvents, readEvents } from '../../src/storage/event-store.js';

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-append-atomic-'));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('appendEvents atomicity', () => {
  it('rolls back the whole batch when one event fails inside the transaction', async () => {
    const project = await createProject({
      title: 'atomic',
      rootPath: sandbox,
      summary: 'batch rollback test',
    });

    const before = (await readEvents(project.id)).length;

    // The second event carries a BigInt payload — JSON.stringify (inside
    // insertEvent) throws on BigInt, which aborts the db.transaction and
    // rolls back the first INSERT too.
    await expect(
      appendEvents(project.id, [
        {
          type: 'task.created',
          projectId: project.id,
          scopeType: 'task',
          scopeId: 'task_ok',
          actor: 'user',
          payload: { id: 'task_ok' } as never,
        },
        {
          type: 'task.created',
          projectId: project.id,
          scopeType: 'task',
          scopeId: 'task_bad',
          actor: 'user',
          payload: { bad: 1n } as never,
        },
      ]),
    ).rejects.toThrow();

    // Full rollback: the event count is unchanged — neither the valid first
    // event nor the failing second event was persisted.
    const after = await readEvents(project.id);
    expect(after.length).toBe(before);
    expect(after.some((e) => e.scopeId === 'task_ok')).toBe(false);
  });
});
