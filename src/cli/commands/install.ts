import {
  installClaudeIntegration,
  installCodexIntegration,
} from '../../services/install-service.js';
import type { CliContext } from '../context.js';

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
    // Codex treats hooks written by external tools as untrusted and
    // SILENTLY skips them (no error, no log) until the user approves
    // them once. Verified live against codex v0.137.0 (2026-06-08):
    // without this approval every memorize codex hook is dead despite
    // the install "succeeding". Surface that loudly here — it is the
    // one step memorize cannot do on the user's behalf.
    console.log('');
    console.log(
      'ACTION REQUIRED: codex ignores externally-written hooks until you approve them.',
    );
    console.log(
      'Open an interactive `codex` session once and accept the hook review prompt —',
    );
    console.log(
      'until then, memorize will not record anything from codex sessions.',
    );
    return;
  }
  throw new Error('Install target must be `claude` or `codex`.');
}
