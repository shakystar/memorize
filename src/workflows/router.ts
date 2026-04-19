import type { ResolvedIntent } from './intents.js';

export function parseIntent(input: string): ResolvedIntent {
  const normalized = input.trim().toLowerCase();

  if (normalized.includes('set') && normalized.includes('collaboration')) {
    return { intent: 'project.init', raw: input };
  }
  if (
    (normalized.includes('bind') || normalized.includes('install')) &&
    (normalized.includes('claude') || normalized.includes('codex')) &&
    (normalized.includes('adapter') || normalized.includes('integration'))
  ) {
    const targetActor = normalized.includes('claude') ? 'claude' : 'codex';
    return {
      intent: 'project.bind_adapter',
      raw: input,
      targetActor,
    };
  }
  if (normalized.includes('resume')) {
    return { intent: 'task.resume', raw: input };
  }
  // Checkpoint before handoff: "checkpoint and hand off" should checkpoint, not handoff.
  // Compound intent is not supported; the first matching intent wins.
  if (normalized.includes('checkpoint')) {
    return { intent: 'task.checkpoint', raw: input };
  }
  if (
    normalized.includes('hand off') ||
    normalized.includes('handoff') ||
    normalized.includes('hand over')
  ) {
    const targetActor = normalized.includes('codex')
      ? 'codex'
      : normalized.includes('claude')
        ? 'claude'
        : undefined;
    return {
      intent: 'task.handoff',
      raw: input,
      ...(targetActor ? { targetActor } : {}),
    };
  }
  if (normalized.includes('task') || normalized.includes('create')) {
    return { intent: 'task.create', raw: input };
  }
  if (normalized.includes('sync')) {
    return { intent: 'project.sync', raw: input };
  }

  return { intent: 'project.summary', raw: input };
}
