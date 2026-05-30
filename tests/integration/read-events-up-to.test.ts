import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProject } from '../../src/services/project-service.js';
import { createTask } from '../../src/services/task-service.js';
import { readEvents, readEventsUpTo } from '../../src/storage/event-store.js';
import { getProjectStateAtRevision } from '../../src/services/projection-store.js';
import { MemorizeError } from '../../src/shared/errors.js';
import { closeAll } from '../../src/storage/db.js';

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-upto-'));
  process.env.MEMORIZE_ROOT = join(sandbox, '.memorize-home');
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('readEventsUpTo / getProjectStateAtRevision', () => {
  it('returns events inclusive up to the given revision in seq order', async () => {
    const project = await createProject({ title: 'TT', rootPath: sandbox });
    const t1 = await createTask({ projectId: project.id, title: 'one', actor: 'user' });
    await createTask({ projectId: project.id, title: 'two', actor: 'user' });

    const all = await readEvents(project.id);
    // The reducer keys tasks by event.scopeId, so select the boundary by scopeId.
    const boundary = all.find(
      (e) => e.type === 'task.created' && e.scopeId === t1.id,
    );
    expect(boundary).toBeDefined();

    const upTo = await readEventsUpTo(project.id, boundary!.id);
    // inclusive: the boundary event is the LAST element
    expect(upTo[upTo.length - 1]!.id).toBe(boundary!.id);
    expect(upTo.length).toBeLessThan(all.length);
    // Both reads are ORDER BY seq and tasks were created serially, so the
    // bounded slice is exactly the prefix of the full log.
    expect(upTo.map((e) => e.id)).toEqual(
      all.slice(0, upTo.length).map((e) => e.id),
    );
  });

  it('getProjectStateAtRevision reduces the bounded slice (differs from HEAD)', async () => {
    const project = await createProject({ title: 'TT2', rootPath: sandbox });
    const t1 = await createTask({ projectId: project.id, title: 'first', actor: 'user' });
    await createTask({ projectId: project.id, title: 'second', actor: 'user' });

    const all = await readEvents(project.id);
    const boundary = all.find(
      (e) => e.type === 'task.created' && e.scopeId === t1.id,
    )!;

    const atRev = await getProjectStateAtRevision(project.id, boundary.id);
    // state-as-of t1: only the first task exists. ProjectState.tasks is
    // Record<scopeId, Task>, so keys are task ids.
    expect(Object.keys(atRev.tasks)).toContain(t1.id);
    expect(Object.keys(atRev.tasks)).toHaveLength(1);
  });

  it('throws MemorizeError on an unknown eventId', async () => {
    const project = await createProject({ title: 'TT3', rootPath: sandbox });
    await expect(
      readEventsUpTo(project.id, 'evt_does_not_exist'),
    ).rejects.toBeInstanceOf(MemorizeError);
  });
});
