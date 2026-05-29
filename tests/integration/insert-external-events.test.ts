import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProject } from '../../src/services/project-service.js';
import {
  insertExternalEvents,
  readEvents,
} from '../../src/storage/event-store.js';
import type { DomainEvent } from '../../src/domain/events.js';
import { closeAll } from '../../src/storage/db.js';

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-insert-ext-'));
  process.env.MEMORIZE_ROOT = join(sandbox, '.memorize-home');
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

function fakeEvent(id: string, projectId: string): DomainEvent {
  return {
    id,
    schemaVersion: '1.0.0',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    type: 'task.updated',
    projectId,
    scopeType: 'task',
    scopeId: 'task_ext_1',
    actor: 'remote-user',
    payload: { status: 'done' } as never,
  };
}

describe('insertExternalEvents', () => {
  it('inserts new events, returns inserted count, dedupes by id, and is idempotent', async () => {
    const project = await createProject({ title: 'Ext', rootPath: sandbox });

    const first = await insertExternalEvents(project.id, [
      fakeEvent('evt_ext_1', project.id),
      fakeEvent('evt_ext_2', project.id),
    ]);
    expect(first).toBe(2);

    // Re-apply the same batch plus one new event: 2 dupes ignored, 1 inserted.
    const second = await insertExternalEvents(project.id, [
      fakeEvent('evt_ext_1', project.id),
      fakeEvent('evt_ext_2', project.id),
      fakeEvent('evt_ext_3', project.id),
    ]);
    expect(second).toBe(1);

    const ids = (await readEvents(project.id)).map((e) => e.id);
    expect(ids).toEqual(
      expect.arrayContaining(['evt_ext_1', 'evt_ext_2', 'evt_ext_3']),
    );
    // No duplicate rows for evt_ext_1.
    expect(ids.filter((id) => id === 'evt_ext_1')).toHaveLength(1);
  });
});
