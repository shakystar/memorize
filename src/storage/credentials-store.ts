import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getCredentialsFile } from './path-resolver.js';

/**
 * Host-scoped bearer-token store (#192) — the git-credential model. `auth login`
 * persists a Hub PAT once per host; clone/sync then resolve it by normalized
 * host when no `--token` is passed, so a new project's first clone carries no
 * secret and the token is not duplicated across every project's sync state.
 *
 * Scope: bearer tokens ONLY. This is **authorization** (host-keyed, the Hub sees
 * the token). It is deliberately separate from the #182 E2E encryption key,
 * which is **confidentiality** (project-keyed, the Hub never sees it) — those
 * MUST NOT share a store, or a Hub-known PAT would sit beside the key that is
 * supposed to be hidden from the Hub.
 *
 * At-rest: plaintext on disk at `0600`, honest like git's `store` helper. An OS
 * keychain backend behind this same interface is the hardening path.
 */

/** host -> bearer token */
type CredentialsFile = Record<string, string>;

/**
 * Reduce a relay `--remote-url` to a stable host key so the same Hub compares
 * equal across trailing slashes, paths, case, and default ports. The relay URL
 * is always a real http(s) URL, so the WHATWG URL parser is the right tool
 * (`new URL('https://h/').host === 'h'`, default :443/:80 omitted).
 */
export function normalizeHost(remoteUrl: string): string {
  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    throw new Error(`Invalid --remote-url: ${remoteUrl} is not a valid URL.`);
  }
  if (!url.host) {
    throw new Error(`Invalid --remote-url: ${remoteUrl} has no host.`);
  }
  return url.host.toLowerCase();
}

async function readAll(): Promise<CredentialsFile> {
  let raw: string;
  try {
    raw = await readFile(getCredentialsFile(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    // Keep only string-valued entries; ignore anything malformed.
    const out: CredentialsFile = {};
    for (const [host, token] of Object.entries(parsed)) {
      if (typeof token === 'string') out[host] = token;
    }
    return out;
  } catch {
    // Corrupt/unparseable credentials file: degrade to "no credentials" rather
    // than crashing every clone/sync. The file is machine-managed and a
    // re-`auth login` repairs it; reads should never be the thing that breaks.
    return {};
  }
}

async function writeAll(creds: CredentialsFile): Promise<void> {
  const file = getCredentialsFile();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  // writeFile's `mode` only applies when CREATING the file; re-assert 0600 in
  // case it pre-existed with looser permissions. Best-effort (no-op on Windows).
  await chmod(file, 0o600).catch(() => undefined);
}

/** The bearer token stored for `remoteUrl`'s host, or undefined. */
export async function readToken(remoteUrl: string): Promise<string | undefined> {
  const creds = await readAll();
  return creds[normalizeHost(remoteUrl)];
}

/** Store (or replace) the bearer token for `remoteUrl`'s host. */
export async function setToken(
  remoteUrl: string,
  token: string,
): Promise<void> {
  const creds = await readAll();
  creds[normalizeHost(remoteUrl)] = token;
  await writeAll(creds);
}

/** Remove the token for `remoteUrl`'s host. Returns false if none was stored. */
export async function deleteToken(remoteUrl: string): Promise<boolean> {
  const creds = await readAll();
  const host = normalizeHost(remoteUrl);
  if (!(host in creds)) return false;
  delete creds[host];
  await writeAll(creds);
  return true;
}

/** Hosts with a stored token, sorted. Tokens themselves are never returned. */
export async function listHosts(): Promise<string[]> {
  return Object.keys(await readAll()).sort();
}

/**
 * Resolve the bearer token for a relay URL along the #192 ladder, most→least
 * specific: an `explicit` token (the `--token` flag, or a per-project persisted
 * token) wins; then the host credential store; then the `MEMORIZE_SYNC_TOKEN`
 * env escape hatch (for CI). Returns undefined when none is configured.
 */
export async function resolveSyncToken(
  remoteUrl: string,
  explicit?: string,
): Promise<string | undefined> {
  if (explicit) return explicit;
  const stored = await readToken(remoteUrl);
  if (stored) return stored;
  return process.env.MEMORIZE_SYNC_TOKEN || undefined;
}
