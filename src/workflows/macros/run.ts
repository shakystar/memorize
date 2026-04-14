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
import type { CheckpointWorkflowOptions } from './checkpoint-task.js';
import type { HandoffWorkflowOptions } from './handoff-task.js';

export interface WorkflowOptions
  extends HandoffWorkflowOptions,
    CheckpointWorkflowOptions {}

export async function runWorkflow(
  intent: ResolvedIntent,
  cwd: string,
  options: WorkflowOptions = {},
): Promise<string> {
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
      return handoffTaskWorkflow(cwd, intent.raw, intent.targetActor, options);
    case 'task.checkpoint':
      return checkpointTaskWorkflow(cwd, intent.raw, options);
    case 'project.bind_adapter':
      return bindAdapterWorkflow(cwd, intent.targetActor);
    default:
      return `Workflow ${workflow.name} is not yet implemented.`;
  }
}
