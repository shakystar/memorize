import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deleteToken,
  listHosts,
  normalizeHost,
  readToken,
  resolveSyncToken,
  setToken,
} from '../../src/storage/credentials-store.js';
import { getCredentialsFile } from '../../src/storage/path-resolver.js';

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-creds-'));
  process.env.MEMORIZE_ROOT = sandbox;
  delete process.env.MEMORIZE_SYNC_TOKEN;
});

afterEach(async () => {
  delete process.env.MEMORIZE_ROOT;
  delete process.env.MEMORIZE_SYNC_TOKEN;
  await rm(sandbox, { recursive: true, force: true });
});

describe('normalizeHost', () => {
  it('treats trailing slash, path, and case as the same host', () => {
    const variants = [
      'https://hub.example.com',
      'https://hub.example.com/',
      'https://HUB.example.com',
      'https://hub.example.com/v1/projects/p',
    ];
    const keys = new Set(variants.map(normalizeHost));
    expect(keys).toEqual(new Set(['hub.example.com']));
  });

  it('keeps a non-default port but drops the default one', () => {
    expect(normalizeHost('https://hub.example.com:8443/')).toBe(
      'hub.example.com:8443',
    );
    expect(normalizeHost('https://hub.example.com:443/')).toBe(
      'hub.example.com',
    );
  });

  it('throws on a non-URL', () => {
    expect(() => normalizeHost('not a url')).toThrow(/Invalid --remote-url/);
  });
});

describe('credentials store round-trip', () => {
  it('returns undefined before anything is stored', async () => {
    expect(await readToken('https://hub.example.com')).toBeUndefined();
    expect(await listHosts()).toEqual([]);
  });

  it('stores and reads a token by normalized host', async () => {
    await setToken('https://hub.example.com/', 'mzk_abc');
    // A different URL spelling for the same host resolves the same token.
    expect(await readToken('https://hub.example.com/v1')).toBe('mzk_abc');
    expect(await listHosts()).toEqual(['hub.example.com']);
  });

  it('replaces the token for a host on re-login', async () => {
    await setToken('https://hub.example.com', 'old');
    await setToken('https://hub.example.com', 'new');
    expect(await readToken('https://hub.example.com')).toBe('new');
    expect(await listHosts()).toEqual(['hub.example.com']);
  });

  it('isolates tokens per host', async () => {
    await setToken('https://a.example.com', 'token-a');
    await setToken('https://b.example.com', 'token-b');
    expect(await readToken('https://a.example.com')).toBe('token-a');
    expect(await readToken('https://b.example.com')).toBe('token-b');
    expect(await listHosts()).toEqual(['a.example.com', 'b.example.com']);
  });

  it('deletes a token and reports whether one existed', async () => {
    await setToken('https://hub.example.com', 'mzk_abc');
    expect(await deleteToken('https://hub.example.com')).toBe(true);
    expect(await readToken('https://hub.example.com')).toBeUndefined();
    // Deleting again is a no-op that reports false.
    expect(await deleteToken('https://hub.example.com')).toBe(false);
  });

  it('tolerates a malformed credentials file (treats it as empty)', async () => {
    process.env.MEMORIZE_ROOT = sandbox;
    await writeFile(getCredentialsFile(), 'not json', 'utf8');
    expect(await readToken('https://hub.example.com')).toBeUndefined();
  });

  it.runIf(process.platform !== 'win32')(
    'writes the credentials file as 0600',
    async () => {
      await setToken('https://hub.example.com', 'mzk_abc');
      const mode = (await stat(getCredentialsFile())).mode & 0o777;
      expect(mode).toBe(0o600);
    },
  );
});

describe('resolveSyncToken ladder', () => {
  it('prefers an explicit token over everything', async () => {
    await setToken('https://hub.example.com', 'stored');
    process.env.MEMORIZE_SYNC_TOKEN = 'env';
    expect(await resolveSyncToken('https://hub.example.com', 'explicit')).toBe(
      'explicit',
    );
  });

  it('falls back to the host store when no explicit token', async () => {
    await setToken('https://hub.example.com', 'stored');
    process.env.MEMORIZE_SYNC_TOKEN = 'env';
    expect(await resolveSyncToken('https://hub.example.com')).toBe('stored');
  });

  it('falls back to env when nothing is stored', async () => {
    process.env.MEMORIZE_SYNC_TOKEN = 'env';
    expect(await resolveSyncToken('https://hub.example.com')).toBe('env');
  });

  it('returns undefined when nothing is configured', async () => {
    expect(await resolveSyncToken('https://hub.example.com')).toBeUndefined();
  });
});
