import type { ResolvedIntent } from './intents.js';

export function parseIntent(input: string): ResolvedIntent {
  const normalized = input.trim().toLowerCase();

  if (normalized.includes('set') && normalized.includes('collaboration')) {
    return { intent: 'project.init', raw: input };
  }
  if (normalized.includes('resume')) {
    return { intent: 'task.resume', raw: input };
  }
  if (normalized.includes('checkpoint')) {
    return normalized.includes('codex')
      ? {
          intent: 'task.checkpoint',
          raw: input,
          targetActor: 'codex',
        }
      : {
          intent: 'task.checkpoint',
          raw: input,
        };
  }
  if (normalized.includes('hand') && normalized.includes('codex')) {
    return { intent: 'task.handoff', raw: input, targetActor: 'codex' };
  }
  if (normalized.includes('task') || normalized.includes('create')) {
    return { intent: 'task.create', raw: input };
  }
  if (normalized.includes('sync')) {
    return { intent: 'project.sync', raw: input };
  }

  return { intent: 'project.summary', raw: input };
}
