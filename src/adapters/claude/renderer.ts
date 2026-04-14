import type { StartupContextPayload } from '../../domain/entities.js';

export function renderClaudeStartupContext(
  payload: StartupContextPayload,
): string {
  const parts = ['# Memorize context', '', `Project: ${payload.projectSummary}`];

  if (payload.projectRules.length > 0) {
    parts.push('Rules:');
    for (const rule of payload.projectRules) {
      parts.push(`- ${rule}`);
    }
  }

  if (payload.workstreamSummary) {
    parts.push(`Workstream: ${payload.workstreamSummary}`);
  }

  if (payload.task) {
    parts.push(`Task: ${payload.task.title}`);
    parts.push(`Goal: ${payload.task.goal}`);
    parts.push(`Status: ${payload.task.status}`);
  }

  return parts.join('\n');
}
