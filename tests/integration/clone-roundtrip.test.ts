import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFileSyncTransport } from '../../src/adapters/sync-transport-file.js';
import { CURRENT_SCHEMA_VERSION } from '../../src/domain/common.js';
import type { DomainEvent } from '../../src/domain/events.js';
import { createProject } from '../../src/services/project-service.js';
import {
  getProjectProjection,
  listTasks,
} from '../../src/services/projection-store.js';
import { doctor } from '../../src/services/repair-service.js';
import {
  cloneProject,
  pullProject,
  pushProject,
} from '../../src/services/sync-service.js';
import { createTask } from '../../src/services/task-service.js';
import { insertExternalEvents, readEvents } from '../../src/storage/event-store.js';
import { closeAll } from '../../src/storage/db.js';

const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-clone-rt-'));
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

function countProjectCreated(events: DomainEvent[]): number {
  return events.filter((e) => e.type === 'project.created').length;
}

// In production A and B are separate machines/processes; here they share one
// process. `getDb` caches connections by projectId (ignoring MEMORIZE_ROOT),
// and a true replica uses the SAME projectId on both "machines", so switching
// roots must drop the connection cache to actually rebind to the other root's
// DB file. Real separate processes get this for free (empty cache on start).
function useMachine(root: string): void {
  closeAll();
  process.env.MEMORIZE_ROOT = root;
}

describe('clone-on-bind — true replica (#30)', () => {
  it('clone adopts remote id, projection reads, and round-trips both ways', async () => {
    const remotePath = join(sandbox, 'remote');
    const homeA = join(sandbox, 'home-a');
    const homeB = join(sandbox, 'home-b');
    const cwdB = join(sandbox, 'b');

    // A: create + task + push.
    useMachine(homeA);
    const projectA = await createProject({
      title: 'Project A',
      rootPath: join(sandbox, 'a'),
    });
    await createTask({ projectId: projectA.id, title: 'Task from A', actor: 'user' });
    const transport = createFileSyncTransport(remotePath);
    await pushProject(projectA.id, transport);

    // B: clone (fresh cwd, adopts A's id — never mints its own).
    useMachine(homeB);
    const cloneResult = await cloneProject(cwdB, projectA.id, transport);
    expect(cloneResult.projectId).toBe(projectA.id);
    expect(cloneResult.pulled).toBeGreaterThan(0);

    // #30 core assertion: B's projection reads under A's id (was empty before).
    const projB = getProjectProjection(projectA.id);
    expect(projB).toBeDefined();
    expect(projB?.id).toBe(projectA.id);
    expect(listTasks(projectA.id).some((t) => t.title === 'Task from A')).toBe(true);

    // Exactly ONE identity in the replica's log.
    expect(countProjectCreated(await readEvents(projectA.id))).toBe(1);

    // B does new work under A's id, pushes back.
    await createTask({ projectId: projectA.id, title: 'Task from B', actor: 'user' });
    await pushProject(projectA.id, transport);

    // A pulls → sees B's task. (A's remoteProjectId was set by its push.)
    useMachine(homeA);
    await pullProject(projectA.id, transport);
    expect(listTasks(projectA.id).some((t) => t.title === 'Task from B')).toBe(true);
    // Still one identity on A too.
    expect(countProjectCreated(await readEvents(projectA.id))).toBe(1);
  });

  it('refuses to clone into a directory already bound to a different project', async () => {
    const remotePath = join(sandbox, 'remote');
    const homeA = join(sandbox, 'home-a');
    const homeB = join(sandbox, 'home-b');
    const cwdB = join(sandbox, 'b');

    useMachine(homeA);
    const projectA = await createProject({
      title: 'Project A',
      rootPath: join(sandbox, 'a'),
    });
    const transport = createFileSyncTransport(remotePath);
    await pushProject(projectA.id, transport);

    // B already has its own local project bound to cwdB → diverged-history merge.
    useMachine(homeB);
    await createProject({ title: 'Local B', rootPath: cwdB });
    await expect(cloneProject(cwdB, projectA.id, transport)).rejects.toThrow(
      /already bound/,
    );
  });

  it('idempotent re-clone pulls nothing new the second time', async () => {
    const remotePath = join(sandbox, 'remote');
    const homeA = join(sandbox, 'home-a');
    const homeB = join(sandbox, 'home-b');
    const cwdB = join(sandbox, 'b');

    useMachine(homeA);
    const projectA = await createProject({
      title: 'Project A',
      rootPath: join(sandbox, 'a'),
    });
    await createTask({ projectId: projectA.id, title: 'Task from A', actor: 'user' });
    const transport = createFileSyncTransport(remotePath);
    await pushProject(projectA.id, transport);

    useMachine(homeB);
    const first = await cloneProject(cwdB, projectA.id, transport);
    expect(first.pulled).toBeGreaterThan(0);
    const second = await cloneProject(cwdB, projectA.id, transport);
    expect(second.pulled).toBe(0);
    expect(getProjectProjection(projectA.id)?.id).toBe(projectA.id);
  });

  it('clone of an empty (never-pushed) remote binds without error, materializes after a later pull', async () => {
    const remotePath = join(sandbox, 'remote');
    const homeA = join(sandbox, 'home-a');
    const homeB = join(sandbox, 'home-b');
    const cwdB = join(sandbox, 'b');

    useMachine(homeA);
    const projectA = await createProject({
      title: 'Project A',
      rootPath: join(sandbox, 'a'),
    });
    // NOTE: no push — remote has nothing for A yet.
    const transport = createFileSyncTransport(remotePath);

    useMachine(homeB);
    const cloneResult = await cloneProject(cwdB, projectA.id, transport);
    expect(cloneResult.pulled).toBe(0);
    expect(getProjectProjection(projectA.id)).toBeUndefined();

    // A pushes later; B pulls → projection materializes.
    useMachine(homeA);
    await pushProject(projectA.id, transport);
    useMachine(homeB);
    await pullProject(projectA.id, transport);
    expect(getProjectProjection(projectA.id)?.id).toBe(projectA.id);
  });

  it('doctor reports a divergent-identity error on an already-clobbered store', async () => {
    const homeA = join(sandbox, 'home-a');
    const rootA = join(sandbox, 'a');
    useMachine(homeA);
    const projectA = await createProject({ title: 'Project A', rootPath: rootA });

    // Simulate a pre-clone-on-bind clobbered store: a second project.created
    // with a DIFFERENT identity lands in A's DB (bypassing the projector).
    const foreign: DomainEvent = {
      id: 'evt_foreign_pc',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z',
      type: 'project.created',
      projectId: 'proj_foreign_other',
      scopeType: 'project',
      scopeId: 'proj_foreign_other',
      actor: 'test',
      payload: { id: 'proj_foreign_other' } as never,
    };
    await insertExternalEvents(projectA.id, [foreign]);

    const report = await doctor(rootA);
    const identity = report.checks.find((c) => c.id === 'project.identity');
    expect(identity?.status).toBe('error');
  });
});

describe('clone-on-bind — CLI', () => {
  it(
    'project clone adopts the remote id end-to-end',
    { timeout: 30_000 },
    async () => {
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
          env: { ...process.env, MEMORIZE_ROOT: memorizeHome },
        });

      expect(runCli(['project', 'init'], sandboxA, homeA).status).toBe(0);
      expect(
        runCli(['task', 'create', 'CLI', 'clone', 'task'], sandboxA, homeA).status,
      ).toBe(0);
      expect(
        runCli(
          ['project', 'sync', '--push', '--remote-path', sharedRemote],
          sandboxA,
          homeA,
        ).status,
      ).toBe(0);

      const showA = runCli(['project', 'show'], sandboxA, homeA);
      const projectIdA = (JSON.parse(String(showA.stdout)) as { id: string }).id;

      // B clones into a FRESH dir — adopts A's id.
      const cloneB = runCli(
        ['project', 'clone', projectIdA, '--remote-path', sharedRemote],
        sandboxB,
        homeB,
      );
      expect(cloneB.status).toBe(0);
      expect(cloneB.stdout).toContain('Cloned project');

      const showB = runCli(['project', 'show'], sandboxB, homeB);
      expect(showB.status).toBe(0);
      const projectIdB = (JSON.parse(String(showB.stdout)) as { id: string }).id;
      expect(projectIdB).toBe(projectIdA); // same identity everywhere
    },
  );
});
