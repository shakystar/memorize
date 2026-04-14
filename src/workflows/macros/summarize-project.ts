import { loadStartContext } from '../../services/context-service.js';
import { getBoundProjectId } from '../../services/project-service.js';
import { resolveWorkflow } from '../resolver.js';

export async function summarizeProjectWorkflow(cwd: string): Promise<string> {
  const projectId = await getBoundProjectId(cwd);
  if (!projectId) {
    throw new Error('No project bound to current directory.');
  }

  const payload = await loadStartContext({ projectId });
  const workflow = resolveWorkflow({ intent: 'project.summary', raw: 'summary' });
  return `Workflow: ${workflow.name}\nProject: ${payload.projectSummary}\nOpen conflicts: ${payload.openConflicts.length}`;
}
