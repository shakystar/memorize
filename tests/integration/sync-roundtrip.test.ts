import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFileSyncTransport } from '../../src/adapters/sync-transport-file.js';
import { closeAll } from '../../src/storage/db.js';
import { createProject } from '../../src/services/project-service.js';
import { createTask } from '../../src/services/task-service.js';
import {
  cloneProject,
  pullProject,
  pushProject,
} from '../../src/services/sync-service.js';
import { readEvents } from '../../src/storage/event-store.js';

const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-sync-rt-'));
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

// A true replica uses the SAME projectId on both "machines"; `getDb` caches
// connections by projectId (ignoring MEMORIZE_ROOT), so switching roots in one
// process must drop the cache to rebind to the other root's DB. Real separate
// processes get this for free.
function useMachine(root: string): void {
  closeAll();
  process.env.MEMORIZE_ROOT = root;
}

describe('sync roundtrip via file transport (true-replica clone)', () => {
  it('A pushes, B clone-adopts A id and receives A events', async () => {
    const remotePath = join(sandbox, 'remote');
    const homeA = join(sandbox, 'home-a');
    const homeB = join(sandbox, 'home-b');

    useMachine(homeA);
    const projectA = await createProject({
      title: 'Project A',
      rootPath: join(sandbox, 'a'),
    });
    await createTask({ projectId: projectA.id, title: 'Task from A', actor: 'user' });

    const transport = createFileSyncTransport(remotePath);
    const pushResponse = await pushProject(projectA.id, transport);
    expect(pushResponse.accepted.length).toBeGreaterThan(0);
    expect(pushResponse.lastAcceptedEventId).toBeDefined();

    const idempotentPush = await pushProject(projectA.id, transport);
    expect(idempotentPush.accepted).toHaveLength(0);

    // B clones — adopts A's id (no divergent local id minted).
    useMachine(homeB);
    const clone = await cloneProject(join(sandbox, 'b'), projectA.id, transport);
    expect(clone.projectId).toBe(projectA.id);
    expect(clone.pulled).toBeGreaterThan(0);

    const inbound = await readEvents(projectA.id);
    expect(inbound.some((event) => event.type === 'task.created')).toBe(true);
    // Exactly one identity — the #30 invariant.
    expect(inbound.filter((e) => e.type === 'project.created')).toHaveLength(1);
  });

  it('re-pull after clone inserts nothing (idempotent watermark)', async () => {
    const remotePath = join(sandbox, 'remote');
    const homeA = join(sandbox, 'home-a');
    const homeB = join(sandbox, 'home-b');

    useMachine(homeA);
    const projectA = await createProject({
      title: 'Project A',
      rootPath: join(sandbox, 'a'),
    });
    await createTask({ projectId: projectA.id, title: 'Task from A', actor: 'user' });
    const transport = createFileSyncTransport(remotePath);
    await pushProject(projectA.id, transport);

    useMachine(homeB);
    const clone = await cloneProject(join(sandbox, 'b'), projectA.id, transport);
    expect(clone.pulled).toBeGreaterThan(0);

    const domainEvents = (e: Awaited<ReturnType<typeof readEvents>>) =>
      e.filter((ev) => ev.type !== 'sync.state.updated');
    const countAfterClone = domainEvents(await readEvents(projectA.id)).length;
    expect(countAfterClone).toBeGreaterThan(0);

    const secondPull = await pullProject(projectA.id, transport);
    expect(secondPull.inserted).toBe(0);
    expect(domainEvents(await readEvents(projectA.id)).length).toBe(countAfterClone);
  });

  it('exposes push + clone through the cli with --remote-path', { timeout: 30_000 }, async () => {
    const sandboxA = join(sandbox, 'a-cli');
    const sandboxB = join(sandbox, 'b-cli');
    const homeA = join(sandbox, 'home-a-cli');
    const homeB = join(sandbox, 'home-b-cli');
    const sharedRemote = join(sandbox, 'remote-cli');

    await mkdir(sandboxA, { recursive: true });
    await mkdir(sandboxB, { recursive: true });

    const runCli = (
      args: string[],
      cwd: string,
      memorizeHome: string,
    ): ReturnType<typeof spawnSync> =>
      spawnSync('node', [tsxCliPath, cliEntryPath, ...args], {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          MEMORIZE_ROOT: memorizeHome,
        },
      });

    expect(runCli(['project', 'init'], sandboxA, homeA).status).toBe(0);
    expect(
      runCli(['task', 'create', 'CLI', 'sync', 'task'], sandboxA, homeA).status,
    ).toBe(0);

    const pushA = runCli(
      ['project', 'sync', '--push', '--remote-path', sharedRemote],
      sandboxA,
      homeA,
    );
    expect(pushA.status).toBe(0);
    expect(pushA.stdout).toContain('Pushed');

    const showA = runCli(['project', 'show'], sandboxA, homeA);
    const projectIdA = (JSON.parse(String(showA.stdout)) as { id: string }).id;

    // B clones into a fresh dir → adopts A's id.
    const cloneB = runCli(
      ['project', 'clone', projectIdA, '--remote-path', sharedRemote],
      sandboxB,
      homeB,
    );
    expect(cloneB.status).toBe(0);
    expect(cloneB.stdout).toContain('Cloned project');

    const showB = runCli(['project', 'show'], sandboxB, homeB);
    expect((JSON.parse(String(showB.stdout)) as { id: string }).id).toBe(projectIdA);
  });
});
