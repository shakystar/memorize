import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeAll } from '../../src/storage/db.js';
import { appendEvent, readEvents, readEventsWithIntegrity } from '../../src/storage/event-store.js';
import { withFileLock } from '../../src/storage/fs-utils.js';

let originalRoot: string | undefined;
let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-evtstore-'));
  originalRoot = process.env['MEMORIZE_ROOT'];
  process.env['MEMORIZE_ROOT'] = sandbox;
});

afterEach(async () => {
  // Release cached SQLite handles before deleting the sandbox, otherwise the
  // open db file blocks rm on Windows and a stale connection leaks into the
  // next test (the per-projectId cache is keyed by id, not by root).
  closeAll();
  if (originalRoot === undefined) {
    delete process.env['MEMORIZE_ROOT'];
  } else {
    process.env['MEMORIZE_ROOT'] = originalRoot;
  }
  await rm(sandbox, { recursive: true, force: true });
});

describe('event store (SQLite)', () => {
  const projectId = 'test_project';

  async function appendTestEvent(label: string) {
    return appendEvent({
      type: 'task.created',
      projectId,
      scopeType: 'task',
      scopeId: `task_${label}`,
      actor: 'test',
      payload: { title: label },
    });
  }

  it('persists appended events and replays them in seq order', async () => {
    await appendTestEvent('good1');
    await appendTestEvent('good2');

    const events = await readEvents(projectId);
    expect(events.map((e) => e.scopeId)).toEqual(['task_good1', 'task_good2']);
  });

  it('readEventsWithIntegrity never reports corrupt lines (whole-row storage)', async () => {
    await appendTestEvent('valid');

    const result = await readEventsWithIntegrity(projectId);
    expect(result.events.length).toBe(1);
    expect(result.corruptLines).toEqual([]);
  });

  it('round-trips payloads through JSON storage', async () => {
    const appended = await appendTestEvent('payload');
    const [event] = await readEvents(projectId);
    expect(event?.payload).toEqual(appended.payload);
    expect(event?.id).toBe(appended.id);
  });

  it('concurrent appends all land exactly once', async () => {
    const promises = Array.from({ length: 20 }, (_, i) =>
      appendTestEvent(`concurrent_${i}`),
    );
    await Promise.all(promises);

    const { events, corruptLines } = await readEventsWithIntegrity(projectId);
    expect(corruptLines).toEqual([]);
    expect(events.length).toBe(20);
  });
});

describe('withFileLock', () => {
  it('serializes concurrent operations', async () => {
    const lockTarget = join(sandbox, 'test-lock-target');
    const results: number[] = [];

    const tasks = Array.from({ length: 5 }, (_, i) =>
      withFileLock(lockTarget, async () => {
        results.push(i);
        await new Promise((r) => setTimeout(r, 10));
      }),
    );
    await Promise.all(tasks);

    expect(results.length).toBe(5);
  });

  it('cleans up stale locks', async () => {
    const lockTarget = join(sandbox, 'stale-target');
    const lockDir = `${lockTarget}.lock`;

    // Create a stale lock (mtime will be current, so we set it to the past)
    await mkdir(lockDir);
    const { utimes } = await import('node:fs/promises');
    const past = new Date(Date.now() - 60_000);
    await utimes(lockDir, past, past);

    let executed = false;
    await withFileLock(lockTarget, async () => {
      executed = true;
    });

    expect(executed).toBe(true);
  });
});
