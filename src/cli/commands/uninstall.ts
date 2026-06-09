import {
  uninstallClaudeIntegration,
  uninstallCodexIntegration,
} from '../../services/install-service.js';
import type { CliContext } from '../context.js';

/**
 * Reverse `memorize install`: strip memorize hook entries (and historical
 * AGENTS blocks) for the given target, preserving the user's other config.
 * Captured memory (events/db) is intentionally NOT removed — uninstall undoes
 * the integration, not the data. `memorize uninstall` with no target does both.
 */
export async function runUninstallCommand(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  const target = args[0];

  if (target === undefined || target === 'claude') {
    const settingsPath = await uninstallClaudeIntegration(ctx.cwd);
    console.log(`Removed Claude integration (${settingsPath})`);
  }
  if (target === undefined || target === 'codex') {
    const hooksPath = await uninstallCodexIntegration(ctx.cwd);
    console.log(`Removed Codex integration (${hooksPath})`);
  }

  if (target !== undefined && target !== 'claude' && target !== 'codex') {
    throw new Error('Uninstall target must be `claude`, `codex`, or omitted (both).');
  }

  console.log('');
  console.log(
    'Captured memory (events/projection) was left intact — uninstall only ' +
      'removes the editor integration.',
  );
}
