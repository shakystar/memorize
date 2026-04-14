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

  if (payload.latestHandoff) {
    const handoff = payload.latestHandoff;
    const handoffLines = [
      '## Latest handoff',
      `- From: ${handoff.fromActor} → ${handoff.toActor}`,
      `- Summary: ${handoff.summary}`,
      `- Next action: ${handoff.nextAction}`,
    ];
    if (handoff.doneItems.length > 0) {
      handoffLines.push(`- Done: ${handoff.doneItems.join('; ')}`);
    }
    if (handoff.remainingItems.length > 0) {
      handoffLines.push(`- Remaining: ${handoff.remainingItems.join('; ')}`);
    }
    if (handoff.warnings.length > 0) {
      handoffLines.push(`- Warnings: ${handoff.warnings.join('; ')}`);
    }
    sections.push(handoffLines.join('\n'));
  }

  return sections.join('\n\n');
}
