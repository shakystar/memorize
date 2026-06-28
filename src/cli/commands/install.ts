import {
  installClaudeIntegration,
  installCodexIntegration,
} from '../../services/install-service.js';
import { getMemorizeRoot } from '../../storage/path-resolver.js';
import type { CliContext } from '../context.js';

/**
 * The two things memorize cannot do on the user's behalf after wiring codex,
 * surfaced as console lines. Shared by `install codex` and `init` (so the
 * exact wording can never drift between them).
 *
 *  1. Codex treats hooks written by external tools as untrusted and SILENTLY
 *     skips them (no error, no log) until the user approves them once. Verified
 *     live against codex v0.137.0 (2026-06-08): without this approval every
 *     memorize codex hook is dead despite the install "succeeding".
 *  2. Codex's default workspace-write sandbox only permits writes under the
 *     project root, but memorize's database lives in ~/.memorize. Without the
 *     writable_roots entry, every in-sandbox command dies with `unable to open
 *     database file`. memorize cannot edit config.toml on the user's behalf (#116).
 */
export function codexPostInstallNotice(): string[] {
  return [
    '',
    'ACTION REQUIRED: codex ignores externally-written hooks until you approve them.',
    'Open an interactive `codex` session once and accept the hook review prompt —',
    'until then, memorize will not record anything from codex sessions.',
    '',
    `If you run codex with the default workspace-write sandbox, also add "${getMemorizeRoot()}"`,
    'to sandbox_workspace_write.writable_roots in ~/.codex/config.toml — otherwise memorize',
    'cannot open its database from inside the sandbox.',
  ];
}

export async function runInstallCommand(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  const target = args[0];
  if (target === 'claude') {
    await installClaudeIntegration(ctx.cwd);
    console.log('Installed Claude integration');
    console.log(
      'Added a memorize ground-rule block to CLAUDE.md (removed by `memorize uninstall claude`).',
    );
    return;
  }
  if (target === 'codex') {
    await installCodexIntegration(ctx.cwd);
    console.log('Installed Codex integration');
    console.log(
      'Added a memorize ground-rule block to AGENTS.md (removed by `memorize uninstall codex`).',
    );
    // Surface the two steps memorize cannot do on the user's behalf (shared
    // with `init` so the wording can never drift).
    for (const line of codexPostInstallNotice()) {
      console.log(line);
    }
    return;
  }
  throw new Error('Install target must be `claude` or `codex`.');
}
