export type IntentName =
  | 'project.init'
  | 'project.bind_adapter'
  | 'task.create'
  | 'task.resume'
  | 'task.handoff'
  | 'task.checkpoint'
  | 'project.sync'
  | 'project.summary';

export interface ResolvedIntent {
  intent: IntentName;
  targetActor?: string;
  raw: string;
}
