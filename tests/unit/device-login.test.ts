import { describe, expect, it, vi } from 'vitest';

import { deviceLogin, resolveOpenCommand } from '../../src/cli/device-login.js';

const BASE = 'https://hub.example.com';

/** A minimal `Response`-shaped stub — only `.ok`, `.status`, `.json()` are read. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/**
 * A fetch stub that answers `/v1/device/code` with a fixed grant and drains
 * `pollQueue` one entry per `/v1/device/token` call. Records call counts.
 */
function makeFetch(pollQueue: Response[]): {
  fetchImpl: typeof fetch;
  calls: { code: number; token: number };
} {
  const calls = { code: 0, token: 0 };
  const fetchImpl = (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith('/v1/device/code')) {
      calls.code += 1;
      return jsonResponse(200, {
        device_code: 'dc_opaque',
        user_code: 'FN2W-ZEHU',
        verification_uri: `${BASE}/device`,
        verification_uri_complete: `${BASE}/device?code=FN2W-ZEHU`,
        expires_in: 600,
        interval: 5,
      });
    }
    if (u.endsWith('/v1/device/token')) {
      calls.token += 1;
      const next = pollQueue.shift();
      if (!next) throw new Error('poll queue exhausted');
      return next;
    }
    throw new Error(`unexpected url ${u}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const inert = { sleep: async () => {}, open: () => {}, log: () => {} };

describe('resolveOpenCommand', () => {
  it('does not route Windows URLs through cmd/start (no shell re-parse of & etc.)', () => {
    const url = 'https://hub.example.com/device?code=FN2W-ZEHU&next=%2Fapp';
    const resolved = resolveOpenCommand('win32', url);

    // The Hub-provided URL must reach the OS opener as a single, un-reparsed
    // argv element — never as an argument to `cmd /c start`, whose parser
    // treats `&`, `|`, `^`, `%` as command syntax.
    expect(resolved).not.toBeNull();
    expect(resolved!.command).not.toBe('cmd');
    expect(resolved!.args).not.toContain('start');
    expect(resolved!.args).toContain(url);
  });

  it('refuses non-http(s) schemes so a hostile Hub URL is never launched', () => {
    expect(resolveOpenCommand('win32', 'file:///C:/Windows/System32/calc.exe')).toBeNull();
    expect(resolveOpenCommand('win32', 'javascript:alert(1)')).toBeNull();
    expect(resolveOpenCommand('darwin', 'not a url')).toBeNull();
  });

  it('passes the URL as a lone argv element on macOS and Linux', () => {
    const url = 'https://hub.example.com/device?a=1&b=2';
    expect(resolveOpenCommand('darwin', url)).toEqual({ command: 'open', args: [url] });
    expect(resolveOpenCommand('linux', url)).toEqual({ command: 'xdg-open', args: [url] });
  });
});

describe('deviceLogin', () => {
  it('polls through authorization_pending and stores the token on approval', async () => {
    const { fetchImpl, calls } = makeFetch([
      jsonResponse(400, { error: 'authorization_pending' }),
      jsonResponse(400, { error: 'authorization_pending' }),
      jsonResponse(200, {
        token: 'mzk_test',
        tokenId: 'tok_1',
        label: 'device login',
      }),
    ]);
    const saveToken = vi.fn(async () => {});

    const result = await deviceLogin(BASE, { fetchImpl, saveToken, ...inert });

    expect(calls.token).toBe(3); // kept polling through both pendings, stopped at 200
    expect(saveToken).toHaveBeenCalledWith(BASE, 'mzk_test');
    expect(result.token).toBe('mzk_test');
  });

  it('honors slow_down by widening the poll interval', async () => {
    const { fetchImpl } = makeFetch([
      jsonResponse(400, { error: 'slow_down' }),
      jsonResponse(200, { token: 'mzk_test' }),
    ]);
    const sleeps: number[] = [];

    await deviceLogin(BASE, {
      fetchImpl,
      saveToken: async () => {},
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      open: () => {},
      log: () => {},
    });

    expect(sleeps[0]).toBe(5000); // initial interval (5s from the grant)
    expect(sleeps[1]).toBe(10000); // +5s after slow_down
  });

  it('rejects and stores nothing when the user denies', async () => {
    const { fetchImpl } = makeFetch([
      jsonResponse(400, { error: 'access_denied' }),
    ]);
    const saveToken = vi.fn(async () => {});

    await expect(
      deviceLogin(BASE, { fetchImpl, saveToken, ...inert }),
    ).rejects.toThrow(/denied/i);
    expect(saveToken).not.toHaveBeenCalled();
  });

  it('rejects when the grant expires', async () => {
    const { fetchImpl } = makeFetch([
      jsonResponse(400, { error: 'expired_token' }),
    ]);

    await expect(
      deviceLogin(BASE, { fetchImpl, saveToken: async () => {}, ...inert }),
    ).rejects.toThrow(/expired/i);
  });
});
