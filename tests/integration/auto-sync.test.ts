import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFileSyncTransport } from '../../src/adapters/sync-transport-file.js';
import { autoPull, autoPush } from '../../src/services/auto-sync-service.js';
import {
  createProject,
  readSyncState,
} from '../../src/services/project-service.js';
import { listTasks } from '../../src/services/projection-store.js';
import { cloneProject, updateSyncState } from '../../src/services/sync-service.js';
import { createTask } from '../../src/services/task-service.js';
import { closeAll } from '../../src/storage/db.js';
import { readEvents } from '../../src/storage/event-store.js';

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-autosync-'));
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

function useMachine(root: string): void {
  closeAll();
  process.env.MEMORIZE_ROOT = root;
}

const taskTitles = (projectId: string): string[] =>
  listTasks(projectId).map((t) => t.title);

describe('auto-sync (P3-b) — background propagation', () => {
  it('propagates both ways with NO manual push/pull — only autoPush/autoPull', async () => {
    const remote = join(sandbox, 'remote');
    const homeA = join(sandbox, 'home-a');
    const homeB = join(sandbox, 'home-b');
    const fileCfg = { type: 'file' as const, location: remote };

    // A: create + opt in to auto-sync (persist transport), then autoPush.
    useMachine(homeA);
    const projectA = await createProject({ title: 'A', rootPath: join(sandbox, 'a') });
    await createTask({ projectId: projectA.id, title: 'A1', actor: 'user' });
    await updateSyncState(projectA.id, {
      remoteProjectId: projectA.id,
      syncEnabled: true,
      syncTransport: fileCfg,
    });
    expect((await autoPush(projectA.id)).ran).toBe(true);

    // B: clone (persists transport) — adopts A's id, gets A1.
    useMachine(homeB);
    await cloneProject(
      join(sandbox, 'b'),
      projectA.id,
      createFileSyncTransport(remote),
      fileCfg,
    );
    expect(taskTitles(projectA.id)).toContain('A1');

    // A adds A2, autoPush.
    useMachine(homeA);
    await createTask({ projectId: projectA.id, title: 'A2', actor: 'user' });
    expect((await autoPush(projectA.id)).ran).toBe(true);

    // B autoPull (no manual pull) → sees A2.
    useMachine(homeB);
    expect((await autoPull(projectA.id)).ran).toBe(true);
    expect(taskTitles(projectA.id)).toContain('A2');

    // B adds B1, autoPush; A autoPull → sees B1.
    await createTask({ projectId: projectA.id, title: 'B1', actor: 'user' });
    expect((await autoPush(projectA.id)).ran).toBe(true);
    useMachine(homeA);
    expect((await autoPull(projectA.id)).ran).toBe(true);
    const a = taskTitles(projectA.id);
    expect(a).toEqual(expect.arrayContaining(['A1', 'A2', 'B1']));
  });

  it('single machine (no syncTransport) is a silent no-op with no churn', async () => {
    useMachine(join(sandbox, 'home-a'));
    const project = await createProject({ title: 'A', rootPath: join(sandbox, 'a') });
    await createTask({ projectId: project.id, title: 'A1', actor: 'user' });

    expect(await autoPush(project.id)).toEqual({ ran: false, reason: 'not-configured' });
    expect(await autoPull(project.id)).toEqual({ ran: false, reason: 'not-configured' });

    // No sync.state.updated churn, no remote directory created.
    const events = await readEvents(project.id);
    expect(events.some((e) => e.type === 'sync.state.updated')).toBe(false);
    await expect(access(join(sandbox, 'remote'))).rejects.toBeTruthy();
  });

  it('no-op autoPull (no new remote events) leaves the pull watermark unchanged', async () => {
    const remote = join(sandbox, 'remote');
    const fileCfg = { type: 'file' as const, location: remote };
    useMachine(join(sandbox, 'home-a'));
    const projectA = await createProject({ title: 'A', rootPath: join(sandbox, 'a') });
    await updateSyncState(projectA.id, {
      remoteProjectId: projectA.id,
      syncEnabled: true,
      syncTransport: fileCfg,
    });
    await autoPush(projectA.id);

    useMachine(join(sandbox, 'home-b'));
    await cloneProject(
      join(sandbox, 'b'),
      projectA.id,
      createFileSyncTransport(remote),
      fileCfg,
    );
    const wm1 = (await readSyncState(projectA.id))?.lastPulledEventId;
    expect((await autoPull(projectA.id)).pulled).toBe(0); // nothing new
    const wm2 = (await readSyncState(projectA.id))?.lastPulledEventId;
    expect(wm2).toBe(wm1);
  });

  it('persisted transport survives a process boundary (no flag needed)', async () => {
    const remote = join(sandbox, 'remote');
    useMachine(join(sandbox, 'home-a'));
    const projectA = await createProject({ title: 'A', rootPath: join(sandbox, 'a') });
    await updateSyncState(projectA.id, {
      remoteProjectId: projectA.id,
      syncEnabled: true,
      syncTransport: { type: 'file', location: remote },
    });
    await createTask({ projectId: projectA.id, title: 'A1', actor: 'user' });
    expect((await autoPush(projectA.id)).ran).toBe(true);

    // Simulate a fresh process: drop caches, re-read state from disk.
    closeAll();
    const state = await readSyncState(projectA.id);
    expect(state?.syncTransport).toEqual({ type: 'file', location: remote });
    // autoPush works again with no path re-supplied.
    await createTask({ projectId: projectA.id, title: 'A2', actor: 'user' });
    expect((await autoPush(projectA.id)).ran).toBe(true);
  });

  it('reentrancy guard: autoPush is a no-op while a push is in flight', async () => {
    const remote = join(sandbox, 'remote');
    useMachine(join(sandbox, 'home-a'));
    const projectA = await createProject({ title: 'A', rootPath: join(sandbox, 'a') });
    await updateSyncState(projectA.id, {
      remoteProjectId: projectA.id,
      syncEnabled: true,
      syncTransport: { type: 'file', location: remote },
      syncStatus: 'syncing',
    });
    expect(await autoPush(projectA.id)).toEqual({ ran: false, reason: 'reentrant' });
  });

  it('concurrent autoPush keeps the relay file uncorrupted (lock serializes appends)', async () => {
    const remote = join(sandbox, 'remote');
    const fileCfg = { type: 'file' as const, location: remote };
    useMachine(join(sandbox, 'home-a'));
    const projectA = await createProject({ title: 'A', rootPath: join(sandbox, 'a') });
    await updateSyncState(projectA.id, {
      remoteProjectId: projectA.id,
      syncEnabled: true,
      syncTransport: fileCfg,
    });
    for (let i = 0; i < 5; i += 1) {
      await createTask({ projectId: projectA.id, title: `T${i}`, actor: 'user' });
    }
    // Two concurrent auto-pushes of overlapping slices.
    await Promise.all([autoPush(projectA.id), autoPush(projectA.id)]);

    // A clone pulls cleanly (every relay line parsed as JSON; dupes ignored).
    useMachine(join(sandbox, 'home-b'));
    await cloneProject(
      join(sandbox, 'b'),
      projectA.id,
      createFileSyncTransport(remote),
      fileCfg,
    );
    expect(taskTitles(projectA.id)).toEqual(
      expect.arrayContaining(['T0', 'T1', 'T2', 'T3', 'T4']),
    );
  });
});
