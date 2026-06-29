import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runAuthCommand } from '../../src/cli/commands/auth.js';
import { readToken, setToken } from '../../src/storage/credentials-store.js';

let sandbox: string;

/** Run an auth subcommand and return everything it printed to stdout. */
async function run(args: string[]): Promise<string> {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    await runAuthCommand(args, { cwd: sandbox });
    return spy.mock.calls.map((c) => String(c[0])).join('\n');
  } finally {
    spy.mockRestore();
  }
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-auth-cmd-'));
  process.env.MEMORIZE_ROOT = sandbox;
  delete process.env.MEMORIZE_SYNC_TOKEN;
});

afterEach(async () => {
  delete process.env.MEMORIZE_ROOT;
  delete process.env.MEMORIZE_SYNC_TOKEN;
  await rm(sandbox, { recursive: true, force: true });
});

describe('memorize auth (#192)', () => {
  it('login stores a token for the host without echoing it', async () => {
    const out = await run([
      'login',
      '--remote-url',
      'https://hub.example.com/',
      '--token',
      'mzk_secret',
    ]);

    expect(await readToken('https://hub.example.com')).toBe('mzk_secret');
    expect(out).toMatch(/Logged in to hub\.example\.com/);
    // The secret must never be printed.
    expect(out).not.toContain('mzk_secret');
  });

  it('login requires --remote-url', async () => {
    await expect(run(['login', '--token', 'x'])).rejects.toThrow(/remote-url/);
  });

  it('status reports per-host and lists all hosts', async () => {
    await setToken('https://hub.example.com', 'mzk_a');
    await setToken('https://other.example.com', 'mzk_b');

    const one = await run(['status', '--remote-url', 'https://hub.example.com']);
    expect(one).toMatch(/Authenticated for hub\.example\.com/);

    const none = await run(['status', '--remote-url', 'https://nope.example.com']);
    expect(none).toMatch(/No stored credential for nope\.example\.com/);

    const all = await run(['status']);
    expect(all).toContain('hub.example.com');
    expect(all).toContain('other.example.com');
    // Tokens are never listed.
    expect(all).not.toContain('mzk_a');
  });

  it('status reports nothing when the store is empty', async () => {
    expect(await run(['status'])).toMatch(/No stored credentials/);
  });

  it('logout removes the token and is idempotent', async () => {
    await setToken('https://hub.example.com', 'mzk_a');

    const first = await run(['logout', '--remote-url', 'https://hub.example.com']);
    expect(first).toMatch(/Logged out of hub\.example\.com/);
    expect(await readToken('https://hub.example.com')).toBeUndefined();

    const again = await run(['logout', '--remote-url', 'https://hub.example.com']);
    expect(again).toMatch(/No stored credential/);
  });

  it('logout requires --remote-url', async () => {
    await expect(run(['logout'])).rejects.toThrow(/remote-url/);
  });

  it('rejects an unknown subcommand', async () => {
    await expect(run(['bogus'])).rejects.toThrow(/Usage/);
  });
});
