import { spawn } from 'node:child_process';

import {
  pollDeviceTokenOnce,
  requestDeviceCode,
} from '../adapters/sync-transport-http.js';
import { normalizeHost, setToken } from '../storage/credentials-store.js';

/**
 * Client driver for the browser device-authorization login (see the transport
 * half in `sync-transport-http.ts` and the wire contract in memorize_hub
 * `docs/protocol/device-auth.md`). Kept out of the `auth` command handler and
 * built entirely on injected dependencies (fetch / sleep / browser-open /
 * token-store), so the poll loop — the part with the RFC-8628 state machine — is
 * unit-testable without a live Hub, real timers, or touching the credentials
 * file.
 */

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolve the OS command that opens `url` in the default browser, or `null`
 * when the URL should not be launched at all.
 *
 * Security: the URL is Hub-provided, so a compromised or mistyped Hub is part
 * of the threat model. Two guards:
 *  - Only ever launch `http(s)` — an unparseable URL or a special scheme
 *    (`file:`, `javascript:`, …) returns `null` and falls back to the printed
 *    copy-paste URL.
 *  - On Windows, use `rundll32 url.dll,FileProtocolHandler <url>` rather than
 *    `cmd /c start "" <url>`. `spawn` hands the URL to rundll32 as a single
 *    argv element with no shell in between, so query separators like `&`, `|`,
 *    `^`, and `%` in the URL are never re-parsed by `cmd.exe` as command
 *    syntax — closing the shell-injection path in the old `start` form.
 */
export function resolveOpenCommand(
  platform: NodeJS.Platform,
  url: string,
): { command: string; args: string[] } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  switch (platform) {
    case 'win32':
      return {
        command: 'rundll32',
        args: ['url.dll,FileProtocolHandler', url],
      };
    case 'darwin':
      return { command: 'open', args: [url] };
    default:
      return { command: 'xdg-open', args: [url] };
  }
}

/**
 * Best-effort: open the approval URL in the user's default browser. Never throws
 * and never blocks — the URL is always printed too, so a headless/locked-down
 * box just falls back to copy-paste.
 */
export function openBrowser(url: string): void {
  try {
    const resolved = resolveOpenCommand(process.platform, url);
    // Non-http(s) or unparseable — do not hand it to the OS; the printed URL
    // is the fallback.
    if (!resolved) return;
    const child = spawn(resolved.command, resolved.args, {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    // A missing `xdg-open` etc. must not surface as an unhandled error.
    child.on('error', () => {});
    child.unref();
  } catch {
    // Spawn itself failed — ignore; the printed URL is the fallback.
  }
}

export interface DeviceLoginDeps {
  /** Injected fetch (tests / custom agents). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected wait (tests pass a no-op). Defaults to real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected browser-open (tests pass a no-op). Defaults to `openBrowser`. */
  open?: (url: string) => void;
  /** Injected token persister (tests spy). Defaults to host-scoped `setToken`. */
  saveToken?: (remoteUrl: string, token: string) => Promise<void>;
  /** Injected user-facing logger. Defaults to `console.log`. */
  log?: (message: string) => void;
  /** Injected clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Suppress the automatic browser open (`--no-browser`). */
  noBrowser?: boolean;
  /** Label for the minted key (defaults to the hostname at the call site). */
  label?: string;
}

/**
 * Run the full device-authorization login against `remoteUrl`: start the grant,
 * show the code + URL (and open the browser unless suppressed), then poll until
 * the Hub reports a terminal outcome. On approval the minted key is stored
 * host-scoped (`0600`) exactly like the bring-your-own-token path, and the
 * `{ host, token }` is returned. Denied / expired both reject with a clear
 * message and store nothing.
 */
export async function deviceLogin(
  remoteUrl: string,
  deps: DeviceLoginDeps = {},
): Promise<{ host: string; token: string }> {
  const sleep = deps.sleep ?? realSleep;
  const open = deps.open ?? openBrowser;
  const save = deps.saveToken ?? setToken;
  const log = deps.log ?? ((message: string) => console.log(message));
  const now = deps.now ?? (() => Date.now());

  const grant = await requestDeviceCode(remoteUrl, {
    ...(deps.label ? { label: deps.label } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });

  log(
    `\nTo authorize this device, open:\n\n    ${grant.verificationUri}\n\n` +
      `and enter the code:\n\n    ${grant.userCode}\n`,
  );
  if (!deps.noBrowser) {
    log(`Opening your browser to approve…`);
    open(grant.verificationUriComplete);
  }
  log('Waiting for approval…');

  const deadline = now() + grant.expiresIn * 1000;
  // The Hub's `interval` is the floor; a `slow_down` widens it by 5s (RFC 8628).
  let intervalMs = Math.max(1, grant.interval) * 1000;

  while (now() < deadline) {
    await sleep(intervalMs);
    const poll = await pollDeviceTokenOnce(remoteUrl, grant.deviceCode, {
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
    switch (poll.status) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        intervalMs += 5000;
        continue;
      case 'access_denied':
        throw new Error(
          'Browser login was denied. Nothing was stored.',
        );
      case 'expired_token':
        throw new Error(
          'The login request expired before it was approved. ' +
            'Run `memorize auth login` again.',
        );
      case 'approved':
        await save(remoteUrl, poll.token);
        return { host: normalizeHost(remoteUrl), token: poll.token };
    }
  }
  throw new Error(
    'The login request expired before it was approved. ' +
      'Run `memorize auth login` again.',
  );
}
