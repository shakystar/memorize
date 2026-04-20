import {
  installClaudeIntegration,
  installCodexIntegration,
} from '../../services/install-service.js';
import { requireBoundProjectId } from '../../services/project-service.js';

export async function bindAdapterWorkflow(
  cwd: string,
  targetActor?: string,
): Promise<string> {
  await requireBoundProjectId(cwd);

  if (targetActor === 'claude') {
    const settingsPath = await installClaudeIntegration(cwd);
    return `Bound Claude adapter (${settingsPath})`;
  }

  if (targetActor === 'codex') {
    const overridePath = await installCodexIntegration(cwd);
    return `Bound Codex adapter (${overridePath})`;
  }

  throw new Error(
    'Bind adapter requires a target actor of "claude" or "codex".',
  );
}
