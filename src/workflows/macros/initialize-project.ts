import { setupProject } from '../../services/setup-service.js';

export async function initializeProjectWorkflow(cwd: string): Promise<string> {
  const result = await setupProject(cwd);
  return `Initialized project ${result.project.title} (${result.project.id})\nImported context files: ${result.importedContextCount}`;
}
