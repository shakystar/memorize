import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
  if (originalRoot === undefined) {
    delete process.env['MEMORIZE_ROOT'];
  } else {
    process.env['MEMORIZE_ROOT'] = originalRoot;
  }
  await rm(sandbox, { recursive: true, force: true });
});

describe('event store integrity', () => {
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

  it('readEvents skips corrupt lines instead of throwing', async () => {
    await appendTestEvent('good1');
    await appendTestEvent('good2');

    // Inject a corrupt line into the event file
    const { readdir } = await import('node:fs/promises');
    const eventsDir = join(sandbox, 'projects', projectId, 'events');
    const files = (await readdir(eventsDir)).filter((f) => f.endsWith('.ndjson'));
    expect(files.length).toBeGreaterThan(0);

    const eventFile = join(eventsDir, files[0]!);
    const content = await readFile(eventFile, 'utf8');
    await writeFile(eventFile, content + '{"truncated json\n', 'utf8');

    const events = await readEvents(projectId);
    expect(events.length).toBe(2);
  });

  it('readEventsWithIntegrity reports corrupt lines', async () => {
    await appendTestEvent('valid');

    const { readdir } = await import('node:fs/promises');
    const eventsDir = join(sandbox, 'projects', projectId, 'events');
    const files = (await readdir(eventsDir)).filter((f) => f.endsWith('.ndjson'));
    const eventFile = join(eventsDir, files[0]!);
    const content = await readFile(eventFile, 'utf8');
    await writeFile(eventFile, content + 'not-json\n', 'utf8');

    const result = await readEventsWithIntegrity(projectId);
    expect(result.events.length).toBe(1);
    expect(result.corruptLines.length).toBe(1);
    expect(result.corruptLines[0]!.file).toBe(files[0]);
    expect(result.corruptLines[0]!.lineNumber).toBe(2);
  });

  it('concurrent appends produce valid ndjson', async () => {
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
