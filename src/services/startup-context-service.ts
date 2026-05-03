import { adapterRegistry } from '../adapters/index.js';
import { loadStartContext } from './context-service.js';
import { ensureBoundProjectId } from './project-service.js';

export interface ComposedStartupContext {
  projectId: string;
  taskId?: string;
  startupContext: string;
}

export async function composeStartupContext(params: {
  agent: 'claude' | 'codex';
  cwd: string;
  selfSessionId?: string;
}): Promise<ComposedStartupContext> {
  const projectId = await ensureBoundProjectId(params.cwd);
  const payload = await loadStartContext({
    projectId,
    ...(params.selfSessionId ? { selfSessionId: params.selfSessionId } : {}),
  });
  const adapter = adapterRegistry[params.agent];
  if (!adapter) {
    throw new Error(`Adapter ${params.agent} is not registered.`);
  }
  return {
    projectId,
    ...(payload.task ? { taskId: payload.task.id } : {}),
    startupContext: adapter.renderStartupContext(payload),
  };
}
