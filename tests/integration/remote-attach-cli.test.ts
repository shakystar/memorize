import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runProjectCommand } from '../../src/cli/commands/project.js';
import { createProject, readSyncState } from '../../src/services/project-service.js';
import {
  getProjectProjection,
  listTasks,
} from '../../src/services/projection-store.js';
import { createTask } from '../../src/services/task-service.js';
import { closeAll } from '../../src/storage/db.js';
import { startRelayStub, type RelayStub } from '../harness/relay-stub.js';

let sandbox: string;
let relay: RelayStub;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-remote-cli-'));
  relay = await startRelayStub();
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await relay.close();
  await rm(sandbox, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// Same caveat as clone-roundtrip.test.ts: "machines" share one process, so
// switching MEMORIZE_ROOT must drop the cached DB connections to rebind.
function useMachine(root: string): void {
  closeAll();
  process.env.MEMORIZE_ROOT = root;
}

describe('memorize remote / clone <hub-url> — git-style onboarding (Hub URL contract)', () => {
  it('remote <url> persists the binding and runs the first push', async () => {
    const homeA = join(sandbox, 'home-a');
    const cwdA = join(sandbox, 'a');
    await mkdir(cwdA, { recursive: true });

    useMachine(homeA);
    const projectA = await createProject({ title: 'Origin', rootPath: cwdA });
    await createTask({ projectId: projectA.id, title: 'Origin task', actor: 'user' });

    // Pretty path (/clone/…) is Hub display sugar — only origin + id matter.
    await runProjectCommand(
      ['remote', `${relay.baseUrl}/clone/${projectA.id}`],
      { cwd: cwdA },
    );

    // Binding persisted: transport + remote id + auto-sync opt-in.
    const state = await readSyncState(projectA.id);
    expect(state?.remoteProjectId).toBe(projectA.id);
    expect(state?.syncEnabled).toBe(true);
    expect(state?.syncTransport).toEqual({ type: 'http', url: relay.baseUrl });

    // First sync ran: the relay now holds the local history.
    const remoteEvents = relay.events(projectA.id);
    expect(remoteEvents.length).toBeGreaterThan(0);
    expect(remoteEvents.some((e) => e.type === 'task.created')).toBe(true);
  });

  it('remote with no args prints the attached remote (git remote -v analog)', async () => {
    const homeA = join(sandbox, 'home-a');
    const cwdA = join(sandbox, 'a');
    await mkdir(cwdA, { recursive: true });

    useMachine(homeA);
    const projectA = await createProject({ title: 'Origin', rootPath: cwdA });

    // Not attached yet → actionable usage error, not a silent success.
    await expect(runProjectCommand(['remote'], { cwd: cwdA })).rejects.toThrow(
      /no remote is attached/,
    );

    await runProjectCommand(
      ['remote', `${relay.baseUrl}/clone/${projectA.id}`],
      { cwd: cwdA },
    );

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runProjectCommand(['remote'], { cwd: cwdA });
    expect(log).toHaveBeenCalledWith(`${projectA.id}\t${relay.baseUrl}`);
  });

  it('clone <hub-url> joins on a second machine end-to-end', async () => {
    const homeA = join(sandbox, 'home-a');
    const homeB = join(sandbox, 'home-b');
    const cwdA = join(sandbox, 'a');
    const cwdB = join(sandbox, 'b');
    await mkdir(cwdA, { recursive: true });
    await mkdir(cwdB, { recursive: true });

    // A: create, work, attach (which pushes).
    useMachine(homeA);
    const projectA = await createProject({ title: 'Origin', rootPath: cwdA });
    await createTask({ projectId: projectA.id, title: 'Task from A', actor: 'user' });
    await runProjectCommand(
      ['remote', `${relay.baseUrl}/clone/${projectA.id}`],
      { cwd: cwdA },
    );

    // B: one copy-pasted URL — adopts A's id and pulls its history.
    useMachine(homeB);
    await runProjectCommand(
      ['clone', `${relay.baseUrl}/clone/${projectA.id}`],
      { cwd: cwdB },
    );

    expect(getProjectProjection(projectA.id)?.id).toBe(projectA.id);
    expect(listTasks(projectA.id).some((t) => t.title === 'Task from A')).toBe(true);

    // Clone persisted the transport too — B is auto-sync eligible with no flags.
    const stateB = await readSyncState(projectA.id);
    expect(stateB?.syncTransport).toEqual({ type: 'http', url: relay.baseUrl });
  });

  it('clone rejects a URL that does not end in a store id', async () => {
    const homeB = join(sandbox, 'home-b');
    const cwdB = join(sandbox, 'b');
    await mkdir(cwdB, { recursive: true });

    useMachine(homeB);
    await expect(
      runProjectCommand(['clone', `${relay.baseUrl}/clone/`], { cwd: cwdB }),
    ).rejects.toThrow(/wsp_… or proj_…/);
  });
});
