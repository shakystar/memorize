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
  'Usage: memorize auth login --remote-url <url> [--token <t>] ' +
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
    await setToken(remoteUrl, token);
    console.log(
      `Logged in to ${normalizeHost(remoteUrl)}. ` +
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
