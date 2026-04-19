import {
  getBoundProjectId,
  resolveActiveTaskId,
} from '../../services/project-service.js';
import { getCurrentSessionId } from '../../services/session-service.js';
import { createCheckpoint } from '../../services/task-service.js';

export interface CheckpointWorkflowOptions {
  summary?: string;
  sessionId?: string;
  taskUpdates?: string[];
  projectUpdates?: string[];
  deferredItems?: string[];
  discardableItems?: string[];
}

export async function checkpointTaskWorkflow(
  cwd: string,
  sentence: string,
  options: CheckpointWorkflowOptions = {},
): Promise<string> {
  const projectId = await getBoundProjectId(cwd);
  if (!projectId) {
    throw new Error('No project bound to current directory.');
  }

  const activeTaskId = await resolveActiveTaskId(projectId);

  const sessionId = options.sessionId ?? (await getCurrentSessionId(cwd));
  const checkpoint = await createCheckpoint({
    projectId,
    sessionId,
    ...(activeTaskId ? { taskId: activeTaskId } : {}),
    summary: options.summary ?? sentence,
    ...(options.taskUpdates?.length
      ? { taskUpdates: options.taskUpdates }
      : {}),
    ...(options.projectUpdates?.length
      ? { projectUpdates: options.projectUpdates }
      : {}),
    ...(options.deferredItems?.length
      ? { deferredItems: options.deferredItems }
      : {}),
    ...(options.discardableItems?.length
      ? { discardableItems: options.discardableItems }
      : {}),
  });

  return `Created checkpoint ${checkpoint.id}`;
}
