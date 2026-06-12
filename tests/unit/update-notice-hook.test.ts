import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  maybeNotifyUpdate,
  UPDATE_CHECK_DISABLED_ENV_VAR,
  type DetachedSpawnImpl,
} from '../../src/services/hook-service.js';
import {
  getUpdateCheckFile,
  recordUpdateCheck,
} from '../../src/services/update-service.js';

let sandbox: string;
let savedDisabled: string | undefined;

interface SpawnCall {
  command: string;
  args: string[];
  options: { cwd: string; detached: boolean; stdio: 'ignore'; windowsHide: boolean };
  unrefCalled: boolean;
}

function fakeSpawn(): { spawnImpl: DetachedSpawnImpl; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawnImpl: DetachedSpawnImpl = (command, args, options) => {
    const call: SpawnCall = { command, args, options, unrefCalled: false };
    calls.push(call);
    return {
      unref: () => {
        call.unrefCalled = true;
      },
    };
  };
  return { spawnImpl, calls };
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-updnotice-'));
  process.env.MEMORIZE_ROOT = sandbox;
  savedDisabled = process.env[UPDATE_CHECK_DISABLED_ENV_VAR];
  delete process.env[UPDATE_CHECK_DISABLED_ENV_VAR];
});

afterEach(async () => {
  delete process.env.MEMORIZE_ROOT;
  if (savedDisabled === undefined) {
    delete process.env[UPDATE_CHECK_DISABLED_ENV_VAR];
  } else {
    process.env[UPDATE_CHECK_DISABLED_ENV_VAR] = savedDisabled;
  }
  await rm(sandbox, { recursive: true, force: true });
});

describe('maybeNotifyUpdate', () => {
  it('stale/missing cache: spawns a detached `update --check` and unrefs', async () => {
    const { spawnImpl, calls } = fakeSpawn();
    await maybeNotifyUpdate(spawnImpl);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe(process.execPath);
    expect(calls[0]!.args[0]).toContain(`${sep}cli${sep}index.js`);
    expect(calls[0]!.args.slice(1)).toEqual(['update', '--check']);
    expect(calls[0]!.options.windowsHide).toBe(true);
    expect(calls[0]!.unrefCalled).toBe(true);
  });

  it('fresh cache with newer version: returns the notice without spawning', async () => {
    await recordUpdateCheck({ npmCapture: async () => '999.0.0\n' });
    const { spawnImpl, calls } = fakeSpawn();
    const notice = await maybeNotifyUpdate(spawnImpl);
    expect(notice).toContain('999.0.0');
    expect(calls).toHaveLength(0);
  });

  it('disabled via env: no spawn, no notice (suite-wide test guard)', async () => {
    process.env[UPDATE_CHECK_DISABLED_ENV_VAR] = '1';
    await recordUpdateCheck({ npmCapture: async () => '999.0.0\n' });
    const { spawnImpl, calls } = fakeSpawn();
    expect(await maybeNotifyUpdate(spawnImpl)).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('never throws into the hook on spawn failure', async () => {
    const failing: DetachedSpawnImpl = () => {
      throw new Error('spawn EPERM');
    };
    await expect(maybeNotifyUpdate(failing)).resolves.toBeUndefined();
  });

  it('corrupt cache: still spawns the detached check (self-heal)', async () => {
    await writeFile(getUpdateCheckFile(), '{not json', 'utf8');
    const { spawnImpl, calls } = fakeSpawn();
    const notice = await maybeNotifyUpdate(spawnImpl);
    expect(notice).toBeUndefined();
    expect(calls).toHaveLength(1); // probe spawned -> next --check overwrites the file
  });
});
