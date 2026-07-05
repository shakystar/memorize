import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runProjectCommand } from '../../src/cli/commands/project.js';
import {
  createProject,
  getBoundProjectId,
  readSyncState,
} from '../../src/services/project-service.js';
import { createTask } from '../../src/services/task-service.js';
import { closeAll } from '../../src/storage/db.js';
import { startRelayStub, type RelayStub } from '../harness/relay-stub.js';

let sandbox: string;
let relay: RelayStub;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-connect-cli-'));
  relay = await startRelayStub();
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await relay.close();
  await rm(sandbox, { recursive: true, force: true });
});

function useMachine(root: string): void {
  closeAll();
  process.env.MEMORIZE_ROOT = root;
}

describe('memorize connect — auto-branch clone/remote', () => {
  it('attaches a remote when the cwd is an exact-bound project', async () => {
    const homeA = join(sandbox, 'home-a');
    const cwdA = join(sandbox, 'a');
    await mkdir(cwdA, { recursive: true });

    useMachine(homeA);
    const projectA = await createProject({ title: 'Origin', rootPath: cwdA });
    await createTask({ projectId: projectA.id, title: 'Origin task', actor: 'user' });

    await runProjectCommand(
      ['connect', `${relay.baseUrl}/clone/${projectA.id}`],
      { cwd: cwdA },
    );

    // Took the REMOTE path: binding persisted + first push landed on the relay.
    const state = await readSyncState(projectA.id);
    expect(state?.remoteProjectId).toBe(projectA.id);
    expect(state?.syncTransport).toEqual({ type: 'http', url: relay.baseUrl });
    expect(relay.events(projectA.id).length).toBeGreaterThan(0);
  });

  it('clones into a fresh dir when there is no binding', async () => {
    // Origin machine seeds the relay.
    const homeA = join(sandbox, 'home-a');
    const cwdA = join(sandbox, 'a');
    await mkdir(cwdA, { recursive: true });
    useMachine(homeA);
    const projectA = await createProject({ title: 'Origin', rootPath: cwdA });
    await createTask({ projectId: projectA.id, title: 'Origin task', actor: 'user' });
    await runProjectCommand(
      ['remote', `${relay.baseUrl}/clone/${projectA.id}`],
      { cwd: cwdA },
    );

    // Second machine, fresh dir: connect must CLONE (adopt the remote id).
    const homeB = join(sandbox, 'home-b');
    const cwdB = join(sandbox, 'b');
    await mkdir(cwdB, { recursive: true });
    useMachine(homeB);

    await runProjectCommand(
      ['connect', `${relay.baseUrl}/clone/${projectA.id}`],
      { cwd: cwdB },
    );

    // Adopted the SAME projectId (true replica) and pulled the origin history.
    expect(await getBoundProjectId(cwdB)).toBe(projectA.id);
    const stateB = await readSyncState(projectA.id);
    expect(stateB?.remoteProjectId).toBe(projectA.id);
  });

  it('rejects a bare non-URL arg before touching the binding', async () => {
    const cwd = join(sandbox, 'x');
    await mkdir(cwd, { recursive: true });
    useMachine(join(sandbox, 'home-x'));
    await expect(
      runProjectCommand(['connect', 'not-a-url'], { cwd }),
    ).rejects.toThrow(/valid URL|must end in/);
  });
});
