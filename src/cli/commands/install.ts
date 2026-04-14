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
    return;
  }
  if (target === 'codex') {
    await installCodexIntegration(ctx.cwd);
    console.log('Installed Codex integration');
    return;
  }
  throw new Error('Install target must be `claude` or `codex`.');
}
