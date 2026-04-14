import type { StartupContextPayload } from '../../domain/entities.js';
import {
  UNTRUSTED_PREAMBLE,
  wrapUntrusted,
} from '../../shared/content-safety.js';

export function renderCodexStartupContext(
  payload: StartupContextPayload,
): string {
  const untrustedSections: string[] = [];

  untrustedSections.push(`## Project summary\n${payload.projectSummary}`);

  if (payload.projectRules.length > 0) {
    untrustedSections.push(
      `## Project rules\n${payload.projectRules
        .map((rule) => `- ${rule}`)
        .join('\n')}`,
    );
  }

  if (payload.workstreamSummary) {
    untrustedSections.push(`## Workstream summary\n${payload.workstreamSummary}`);
  }

  if (payload.task) {
    untrustedSections.push(
      `## Current task\n- Title: ${payload.task.title}\n- Goal: ${payload.task.goal}\n- Status: ${payload.task.status}`,
    );
  }

  if (payload.latestHandoff) {
    const handoff = payload.latestHandoff;
    const handoffLines = [
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
    untrustedSections.push(handoffLines.join('\n'));
  }

  const body = wrapUntrusted(untrustedSections.join('\n\n'), {
    source: 'memorize.startup',
  });

  return [
    '# Memorize startup context',
    '',
    UNTRUSTED_PREAMBLE,
    '',
    body,
  ].join('\n');
}
