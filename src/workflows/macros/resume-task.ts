import { adapterRegistry } from '../../adapters/index.js';
import { loadStartContext } from '../../services/context-service.js';
import { getBoundProjectId } from '../../services/project-service.js';

export async function resumeTaskWorkflow(cwd: string): Promise<string> {
  const projectId = await getBoundProjectId(cwd);
  if (!projectId) {
    throw new Error('No project bound to current directory.');
  }

  const payload = await loadStartContext({ projectId });
  const codexAdapter = adapterRegistry.codex;
  if (!codexAdapter) {
    throw new Error('Codex adapter is not registered.');
  }
  return codexAdapter.renderStartupContext(payload);
}
