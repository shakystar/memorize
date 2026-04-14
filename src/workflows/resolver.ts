import type { IntentName, ResolvedIntent } from './intents.js';

export interface WorkflowTemplate {
  name: string;
  steps: string[];
}

const workflowTemplates: Record<IntentName, WorkflowTemplate> = {
  'project.init': {
    name: 'initialize_project',
    steps: ['ensure_project_exists', 'bind_project', 'create_default_workstream'],
  },
  'project.bind_adapter': {
    name: 'bind_adapter',
    steps: ['bind_adapter'],
  },
  'task.create': {
    name: 'create_task_with_context',
    steps: ['create_task'],
  },
  'task.resume': {
    name: 'resume_task_with_context',
    steps: ['resolve_task', 'load_start_context', 'render_startup_context'],
  },
  'task.handoff': {
    name: 'handoff_to_actor',
    steps: ['resolve_task', 'generate_handoff'],
  },
  'task.checkpoint': {
    name: 'checkpoint_and_close_session',
    steps: ['resolve_task', 'create_checkpoint'],
  },
  'project.sync': {
    name: 'sync_project_state',
    steps: ['load_sync_state'],
  },
  'project.summary': {
    name: 'summarize_project_status',
    steps: ['resolve_project', 'load_memory_index'],
  },
};

export function resolveWorkflow(intent: ResolvedIntent): WorkflowTemplate {
  return workflowTemplates[intent.intent];
}
