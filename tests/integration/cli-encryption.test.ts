import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runProjectCommand } from '../../src/cli/commands/project.js';
import {
  generateProjectKey,
  keyId,
} from '../../src/services/encryption-service.js';
import {
  getBoundProjectId,
  readSyncState,
} from '../../src/services/project-service.js';
import { closeAll } from '../../src/storage/db.js';

let sandbox: string;
let cwd: string;

/** Run a project subcommand and return everything it printed to stdout. */
async function run(args: string[]): Promise<string> {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    await runProjectCommand(args, { cwd });
    return spy.mock.calls.map((c) => String(c[0])).join('\n');
  } finally {
    spy.mockRestore();
  }
}

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), 'memorize-cli-enc-')));
  process.env.MEMORIZE_ROOT = join(sandbox, 'root');
  cwd = join(sandbox, 'proj');
  await mkdir(cwd, { recursive: true });
  await runProjectCommand(['init'], { cwd });
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('project encryption provisioning (#182)', () => {
  it('reports disabled before any key is set', async () => {
    const out = await run(['encryption', 'show']);
    expect(out).toMatch(/not enabled/);
  });

  it('enable generates a key, persists it, and prints key + matching kid', async () => {
    const out = await run(['encryption', 'enable']);

    const projectId = await getBoundProjectId(cwd);
    const state = await readSyncState(projectId!);
    expect(state?.encryptionKey).toBeTruthy();

    const key = state!.encryptionKey!;
    // The printed key and kid are the ones actually stored — the out-of-band
    // contract: what you copy is what decrypts on the replica.
    expect(out).toContain(key);
    expect(out).toContain(keyId(key));
    // A generated key is a valid 32-byte (base64) AES-256 key.
    expect(Buffer.from(key, 'base64')).toHaveLength(32);
  });

  it('enable --key adopts a provided key verbatim', async () => {
    const key = generateProjectKey();
    await run(['encryption', 'enable', '--key', key]);

    const projectId = await getBoundProjectId(cwd);
    const state = await readSyncState(projectId!);
    expect(state?.encryptionKey).toBe(key);
  });

  it('refuses to overwrite an existing key without --force', async () => {
    await run(['encryption', 'enable']);
    await expect(run(['encryption', 'enable'])).rejects.toThrow(
      /already enabled/,
    );
  });

  it('enable --force replaces the key', async () => {
    await run(['encryption', 'enable']);
    const replacement = generateProjectKey();
    await run(['encryption', 'enable', '--force', '--key', replacement]);

    const projectId = await getBoundProjectId(cwd);
    const state = await readSyncState(projectId!);
    expect(state?.encryptionKey).toBe(replacement);
  });

  it('rejects a malformed key with a clear length error', async () => {
    await expect(
      run(['encryption', 'enable', '--key', 'not-a-valid-key']),
    ).rejects.toThrow(/Invalid encryption key/);
  });

  it('show prints the stored key for out-of-band sharing', async () => {
    await run(['encryption', 'enable', '--key', generateProjectKey()]);
    const projectId = await getBoundProjectId(cwd);
    const key = (await readSyncState(projectId!))!.encryptionKey!;

    const out = await run(['encryption', 'show']);
    expect(out).toMatch(/ENABLED/);
    expect(out).toContain(key);
    expect(out).toContain(keyId(key));
  });

  it('disable removes the key so future pushes are plaintext', async () => {
    await run(['encryption', 'enable']);
    await run(['encryption', 'disable']);

    const projectId = await getBoundProjectId(cwd);
    const state = await readSyncState(projectId!);
    expect(state?.encryptionKey).toBeUndefined();
  });

  it('rejects an unknown encryption action', async () => {
    await expect(run(['encryption', 'bogus'])).rejects.toThrow(/Usage/);
  });
});

describe('project clone --encryption-key (#182)', () => {
  it('validates the key up front, before touching the remote', async () => {
    // A bad key must fail on the length check, NOT as a network/clone error —
    // proving the flag is validated at the CLI boundary.
    await expect(
      runProjectCommand(
        [
          'clone',
          'proj_remote',
          '--remote-path',
          join(sandbox, 'nowhere'),
          '--encryption-key',
          'too-short',
        ],
        { cwd: join(sandbox, 'fresh-replica') },
      ),
    ).rejects.toThrow(/Invalid encryption key/);
  });
});
