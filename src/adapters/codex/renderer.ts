import type { StartupContextPayload } from '../../domain/entities.js';

export function renderCodexStartupContext(
  payload: StartupContextPayload,
): string {
  const sections = [
    '# Memorize startup context',
    '',
    `## Project summary\n${payload.projectSummary}`,
  ];

  if (payload.projectRules.length > 0) {
    sections.push(
      `## Project rules\n${payload.projectRules
        .map((rule) => `- ${rule}`)
        .join('\n')}`,
    );
  }

  if (payload.workstreamSummary) {
    sections.push(`## Workstream summary\n${payload.workstreamSummary}`);
  }

  if (payload.task) {
    sections.push(
      `## Current task\n- Title: ${payload.task.title}\n- Goal: ${payload.task.goal}\n- Status: ${payload.task.status}`,
    );
  }

  return sections.join('\n\n');
}
