import { getBoundProjectId, readProject } from '../../services/project-service.js';
import { createHandoff } from '../../services/task-service.js';

export async function handoffTaskWorkflow(
  cwd: string,
  sentence: string,
  targetActor?: string,
): Promise<string> {
  const projectId = await getBoundProjectId(cwd);
  if (!projectId) {
    throw new Error('No project bound to current directory.');
  }

  const project = await readProject(projectId);
  const activeTaskId = project?.activeTaskIds[0];
  if (!activeTaskId) {
    throw new Error('No active task to hand off. Create a task first.');
  }

  const handoff = await createHandoff({
    projectId,
    taskId: activeTaskId,
    fromActor: 'user',
    toActor: targetActor ?? 'next-agent',
    summary: sentence,
    nextAction: 'Continue from the latest handoff summary.',
  });

  return `Created handoff ${handoff.id} → ${handoff.toActor}`;
}
