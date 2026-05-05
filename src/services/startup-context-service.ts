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
  /** When set, pin the startup context to this task instead of
   *  letting the picker choose. Used by the resume path so the
   *  re-attached agent gets back the task it previously claimed,
   *  not whatever happens to surface from the picker now (which
   *  may be a different unclaimed task entirely). Mirrors the
   *  same pin in `runResumeTask` for the explicit CLI path. */
  taskId?: string;
}): Promise<ComposedStartupContext> {
  const projectId = await ensureBoundProjectId(params.cwd);
  const payload = await loadStartContext({
    projectId,
    ...(params.selfSessionId ? { selfSessionId: params.selfSessionId } : {}),
    ...(params.taskId ? { taskId: params.taskId } : {}),
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
