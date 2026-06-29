import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runAuthCommand } from '../../src/cli/commands/auth.js';
import { readToken, setToken } from '../../src/storage/credentials-store.js';
import { startRelayStub, type RelayStub } from '../harness/relay-stub.js';

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
    // --no-validate keeps this case offline; validation is covered separately.
    const out = await run([
      'login',
      '--remote-url',
      'https://hub.example.com/',
      '--token',
      'mzk_secret',
      '--no-validate',
    ]);

    expect(await readToken('https://hub.example.com')).toBe('mzk_secret');
    expect(out).toMatch(/Logged in to hub\.example\.com/);
    // The secret must never be printed.
    expect(out).not.toContain('mzk_secret');
  });

  it('login requires --remote-url', async () => {
    await expect(
      run(['login', '--token', 'x', '--no-validate']),
    ).rejects.toThrow(/remote-url/);
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

describe('memorize auth login — Hub validation (#192)', () => {
  let relay: RelayStub;

  afterEach(async () => {
    await relay?.close();
  });

  it('validates a good token against the Hub and stores it', async () => {
    relay = await startRelayStub({ token: 'mzk_good' });
    const out = await run([
      'login',
      '--remote-url',
      relay.baseUrl,
      '--token',
      'mzk_good',
    ]);
    expect(out).toMatch(/token validated/);
    expect(await readToken(relay.baseUrl)).toBe('mzk_good');
  });

  it('rejects a bad token (401) and stores nothing', async () => {
    relay = await startRelayStub({ token: 'mzk_good' });
    await expect(
      run(['login', '--remote-url', relay.baseUrl, '--token', 'mzk_wrong']),
    ).rejects.toThrow(/rejected/i);
    expect(await readToken(relay.baseUrl)).toBeUndefined();
  });

  it('stores anyway with a warning when the Hub is unreachable', async () => {
    // Port 1 is unconnectable; the probe degrades to "store anyway".
    const out = await run([
      'login',
      '--remote-url',
      'http://127.0.0.1:1',
      '--token',
      'mzk_offline',
    ]);
    expect(out).toMatch(/Could not reach/i);
    expect(await readToken('http://127.0.0.1:1')).toBe('mzk_offline');
  });

  it('--no-validate skips the probe entirely (stores even a bad token)', async () => {
    relay = await startRelayStub({ token: 'mzk_good' });
    const out = await run([
      'login',
      '--remote-url',
      relay.baseUrl,
      '--token',
      'mzk_wrong',
      '--no-validate',
    ]);
    expect(out).not.toMatch(/validated/);
    expect(await readToken(relay.baseUrl)).toBe('mzk_wrong');
  });
});
