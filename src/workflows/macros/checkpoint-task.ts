import { getBoundProjectId, readProject } from '../../services/project-service.js';
import { createCheckpoint } from '../../services/task-service.js';

export async function checkpointTaskWorkflow(
  cwd: string,
  sentence: string,
): Promise<string> {
  const projectId = await getBoundProjectId(cwd);
  if (!projectId) {
    throw new Error('No project bound to current directory.');
  }

  const project = await readProject(projectId);
  const activeTaskId = project?.activeTaskIds[0];

  const checkpoint = await createCheckpoint({
    projectId,
    sessionId: `session_${Date.now()}`,
    ...(activeTaskId ? { taskId: activeTaskId } : {}),
    summary: sentence,
  });

  return `Created checkpoint ${checkpoint.id}`;
}
