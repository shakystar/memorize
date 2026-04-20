import { adapterRegistry } from '../../adapters/index.js';
import { loadStartContext } from '../../services/context-service.js';
import { requireBoundProjectId } from '../../services/project-service.js';

export async function resumeTaskWorkflow(cwd: string): Promise<string> {
  const projectId = await requireBoundProjectId(cwd);

  const payload = await loadStartContext({ projectId });
  const codexAdapter = adapterRegistry.codex;
  if (!codexAdapter) {
    throw new Error('Codex adapter is not registered.');
  }
  return codexAdapter.renderStartupContext(payload);
}
