import type { StartupContextPayload } from '../../domain/entities.js';
import {
  UNTRUSTED_PREAMBLE,
  wrapUntrusted,
} from '../../shared/content-safety.js';

export function renderCodexStartupContext(
  payload: StartupContextPayload,
): string {
  const blocks: string[] = [];

  const projectSections: string[] = [
    `## Project summary\n${payload.projectSummary}`,
  ];
  if (payload.projectRules.length > 0) {
    projectSections.push(
      `## Project rules\n${payload.projectRules
        .map((rule) => `- ${rule}`)
        .join('\n')}`,
    );
  }
  if (payload.workstreamSummary) {
    projectSections.push(
      `## Workstream summary\n${payload.workstreamSummary}`,
    );
  }
  blocks.push(
    wrapUntrusted(projectSections.join('\n\n'), {
      source: 'memorize.project',
    }),
  );

  if (payload.task) {
    const taskBody = `## Current task\n- Title: ${payload.task.title}\n- Goal: ${payload.task.goal}\n- Status: ${payload.task.status}`;
    blocks.push(wrapUntrusted(taskBody, { source: 'memorize.task' }));
  }

  if (payload.latestHandoff) {
    const handoff = payload.latestHandoff;
    const handoffLines: string[] = [
      '## Latest handoff',
      `- From: ${handoff.fromActor} → ${handoff.toActor}`,
    ];
    if (handoff.fromActor === 'user') {
      handoffLines.push(
        '- Trust note: user-authored intent. Verify code/test state independently before trusting claims of "done".',
      );
    }
    handoffLines.push(
      `- Summary: ${handoff.summary}`,
      `- Next action: ${handoff.nextAction}`,
    );
    if (handoff.doneItems.length > 0) {
      handoffLines.push(`- Done: ${handoff.doneItems.join('; ')}`);
    }
    if (handoff.remainingItems.length > 0) {
      handoffLines.push(`- Remaining: ${handoff.remainingItems.join('; ')}`);
    }
    if (handoff.warnings.length > 0) {
      handoffLines.push(`- Warnings: ${handoff.warnings.join('; ')}`);
    }
    blocks.push(
      wrapUntrusted(handoffLines.join('\n'), {
        source: 'memorize.handoff',
        actor: handoff.fromActor,
      }),
    );
  }

  return [
    '# Memorize startup context',
    '',
    UNTRUSTED_PREAMBLE,
    '',
    blocks.join('\n\n'),
  ].join('\n');
}
