import { probeHubAuth } from '../../adapters/sync-transport-http.js';
import {
  deleteToken,
  listHosts,
  normalizeHost,
  readToken,
  setToken,
} from '../../storage/credentials-store.js';
import { getCredentialsFile } from '../../storage/path-resolver.js';
import type { CliContext } from '../context.js';
import { parseFlags } from '../parse-flags.js';

const LOGIN_USAGE =
  'Usage: memorize auth login --remote-url <url> [--token <t>] [--no-validate] ' +
  '(or pipe the token on stdin)';
const STATUS_USAGE = 'Usage: memorize auth status [--remote-url <url>]';
const LOGOUT_USAGE = 'Usage: memorize auth logout --remote-url <url>';
const USAGE = `${LOGIN_USAGE}\n${STATUS_USAGE}\n${LOGOUT_USAGE}`;

async function readStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * `memorize auth …` — host-scoped sync credential store (#192), the
 * git-credential model. Authenticate once per Hub host, then clone/sync carry
 * no inline `--token`. The token is **authorization** (Hub-visible), kept
 * deliberately separate from the #182 E2E encryption key (Hub-hidden).
 */
export async function runAuthCommand(
  args: string[],
  _ctx: CliContext,
): Promise<void> {
  const subcommand = args[0];

  if (subcommand === 'login') {
    const flags = parseFlags(args.slice(1), {
      single: ['remote-url', 'token'],
      boolean: ['no-validate'],
    });
    const remoteUrl = flags.single['remote-url'];
    if (!remoteUrl) throw new Error(LOGIN_USAGE);
    // Prefer --token; otherwise read a piped token (so the secret can stay out
    // of shell history: `printf %s "$PAT" | memorize auth login --remote-url …`).
    const token = (flags.single.token ?? (await readStdin()) ?? '').trim();
    if (!token) {
      throw new Error(
        `No token provided. Pass --token <t> or pipe it on stdin. ${LOGIN_USAGE}`,
      );
    }
    const host = normalizeHost(remoteUrl);
    // Fail-fast validation (#192): probe the Hub before persisting so a typo'd or
    // expired key is rejected here rather than as a deferred auto-sync failure
    // later. Only a definitive 401/403 aborts; an unreachable/non-conformant Hub
    // degrades to "store anyway" so offline/CI provisioning still works.
    // `--no-validate` skips the network entirely.
    if (!flags.boolean['no-validate']) {
      const probe = await probeHubAuth(remoteUrl, token);
      if (probe === 'unauthorized') {
        throw new Error(
          `Token rejected by ${host} (401/403). Nothing was stored. ` +
            `Check the key, or pass --no-validate to store it without checking.`,
        );
      }
      await setToken(remoteUrl, token);
      console.log(
        probe === 'ok'
          ? `Logged in to ${host} (token validated). ` +
              `Token stored (0600) at ${getCredentialsFile()}.`
          : `Logged in to ${host}. ⚠ Could not reach the Hub to validate the ` +
              `token; stored it anyway (0600) at ${getCredentialsFile()}.`,
      );
      return;
    }
    await setToken(remoteUrl, token);
    console.log(
      `Logged in to ${host}. ` +
        `Token stored (0600) at ${getCredentialsFile()}.`,
    );
    return;
  }

  if (subcommand === 'status') {
    const flags = parseFlags(args.slice(1), { single: ['remote-url'] });
    const remoteUrl = flags.single['remote-url'];
    if (remoteUrl) {
      const host = normalizeHost(remoteUrl);
      const token = await readToken(remoteUrl);
      console.log(
        token
          ? `Authenticated for ${host}.`
          : `No stored credential for ${host}.`,
      );
      return;
    }
    const hosts = await listHosts();
    if (hosts.length === 0) {
      console.log('No stored credentials.');
      return;
    }
    console.log(
      `Stored credentials (${hosts.length}):\n` +
        hosts.map((h) => `  ${h}`).join('\n'),
    );
    return;
  }

  if (subcommand === 'logout') {
    const flags = parseFlags(args.slice(1), { single: ['remote-url'] });
    const remoteUrl = flags.single['remote-url'];
    if (!remoteUrl) throw new Error(LOGOUT_USAGE);
    const removed = await deleteToken(remoteUrl);
    console.log(
      removed
        ? `Logged out of ${normalizeHost(remoteUrl)}.`
        : `No stored credential for ${normalizeHost(remoteUrl)}.`,
    );
    return;
  }

  throw new Error(USAGE);
}
