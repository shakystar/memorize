import { getBoundProjectId } from '../../services/project-service.js';
import { createTask } from '../../services/task-service.js';

export async function createTaskWorkflow(
  cwd: string,
  sentence: string,
): Promise<string> {
  const projectId = await getBoundProjectId(cwd);
  if (!projectId) {
    throw new Error('No project bound to current directory.');
  }

  const task = await createTask({
    projectId,
    title: sentence,
    description: sentence,
    actor: 'user',
  });
  return `Created task ${task.id}: ${task.title}`;
}
