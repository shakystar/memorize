import type { ResolvedIntent } from '../intents.js';
import { resolveWorkflow } from '../resolver.js';
import {
  bindAdapterWorkflow,
  checkpointTaskWorkflow,
  createTaskWorkflow,
  handoffTaskWorkflow,
  initializeProjectWorkflow,
  resumeTaskWorkflow,
  summarizeProjectWorkflow,
} from './index.js';

export async function runWorkflow(intent: ResolvedIntent, cwd: string): Promise<string> {
  const workflow = resolveWorkflow(intent);

  switch (intent.intent) {
    case 'project.init':
      return `${await initializeProjectWorkflow(cwd)}\nWorkflow: ${workflow.name}`;
    case 'task.create':
      return createTaskWorkflow(cwd, intent.raw);
    case 'task.resume':
      return resumeTaskWorkflow(cwd);
    case 'project.summary':
      return summarizeProjectWorkflow(cwd);
    case 'project.sync':
      return 'Project sync foundation is not yet implemented.';
    case 'task.handoff':
      return handoffTaskWorkflow(cwd, intent.raw, intent.targetActor);
    case 'task.checkpoint':
      return checkpointTaskWorkflow(cwd, intent.raw);
    case 'project.bind_adapter':
      return bindAdapterWorkflow(cwd, intent.targetActor);
    default:
      return `Workflow ${workflow.name} is not yet implemented.`;
  }
}
