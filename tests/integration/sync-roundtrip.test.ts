import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFileSyncTransport } from '../../src/adapters/sync-transport-file.js';
import { createProject } from '../../src/services/project-service.js';
import { createTask } from '../../src/services/task-service.js';
import {
  drainInbound,
  pullProject,
  pushProject,
  updateSyncState,
} from '../../src/services/sync-service.js';

const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-sync-rt-'));
});

afterEach(async () => {
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('sync roundtrip via file transport', () => {
  it('pushes events from project A and lets project B pull them via the service API', async () => {
    const remotePath = join(sandbox, 'remote');
    const homeA = join(sandbox, 'home-a');
    const homeB = join(sandbox, 'home-b');

    process.env.MEMORIZE_ROOT = homeA;
    const projectA = await createProject({
      title: 'Project A',
      rootPath: join(sandbox, 'a'),
    });
    await createTask({
      projectId: projectA.id,
      title: 'Task from A',
      actor: 'user',
    });

    const transport = createFileSyncTransport(remotePath);
    const pushResponse = await pushProject(projectA.id, transport);
    expect(pushResponse.accepted.length).toBeGreaterThan(0);
    expect(pushResponse.lastAcceptedEventId).toBeDefined();

    const idempotentPush = await pushProject(projectA.id, transport);
    expect(idempotentPush.accepted).toHaveLength(0);

    process.env.MEMORIZE_ROOT = homeB;
    const projectB = await createProject({
      title: 'Project B',
      rootPath: join(sandbox, 'b'),
    });
    await updateSyncState(projectB.id, { remoteProjectId: projectA.id });

    const pullResponse = await pullProject(projectB.id, transport);
    expect(pullResponse.events.length).toBeGreaterThan(0);
    expect(pullResponse.lastRemoteEventId).toBe(pushResponse.lastAcceptedEventId);

    const inbound = await drainInbound(projectB.id);
    expect(inbound.some((event) => event.type === 'task.created')).toBe(true);
  });

  it('exposes push/pull/bind through the cli with --remote-path', { timeout: 30_000 }, async () => {
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

    expect(runCli(['project', 'init'], sandboxB, homeB).status).toBe(0);

    const showA = runCli(['project', 'show'], sandboxA, homeA);
    const projectIdA = (JSON.parse(String(showA.stdout)) as { id: string }).id;

    const bindB = runCli(
      ['project', 'sync', '--bind', projectIdA],
      sandboxB,
      homeB,
    );
    expect(bindB.status).toBe(0);
    expect(bindB.stdout).toContain(projectIdA);

    const pullB = runCli(
      ['project', 'sync', '--pull', '--remote-path', sharedRemote],
      sandboxB,
      homeB,
    );
    expect(pullB.status).toBe(0);
    expect(pullB.stdout).toContain('Pulled');
    expect(pullB.stdout).not.toContain('Pulled 0 events');
  });
});
