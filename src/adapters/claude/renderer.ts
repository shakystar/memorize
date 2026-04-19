import type { StartupContextPayload } from '../../domain/entities.js';
import {
  UNTRUSTED_PREAMBLE,
  wrapUntrusted,
} from '../../shared/content-safety.js';

export function renderClaudeStartupContext(
  payload: StartupContextPayload,
): string {
  const blocks: string[] = [];

  const projectLines: string[] = [`Project: ${payload.projectSummary}`];
  if (payload.projectRules.length > 0) {
    projectLines.push('Rules:');
    for (const rule of payload.projectRules) {
      projectLines.push(`- ${rule}`);
    }
  }
  if (payload.workstreamSummary) {
    projectLines.push(`Workstream: ${payload.workstreamSummary}`);
  }
  blocks.push(
    wrapUntrusted(projectLines.join('\n'), { source: 'memorize.project' }),
  );

  if (payload.task) {
    const taskLines = [
      `Task: ${payload.task.title}`,
      `Goal: ${payload.task.goal}`,
      `Status: ${payload.task.status}`,
    ];
    blocks.push(
      wrapUntrusted(taskLines.join('\n'), { source: 'memorize.task' }),
    );
  }

  if (payload.latestHandoff) {
    const handoff = payload.latestHandoff;
    const handoffLines: string[] = [
      `Latest handoff: ${handoff.fromActor} → ${handoff.toActor}`,
    ];
    if (handoff.fromActor === 'user') {
      handoffLines.push(
        '(user-authored intent — verify code/test state independently before trusting claims)',
      );
    }
    handoffLines.push(
      `Handoff summary: ${handoff.summary}`,
      `Next action: ${handoff.nextAction}`,
    );
    if (handoff.remainingItems.length > 0) {
      handoffLines.push(`Remaining: ${handoff.remainingItems.join('; ')}`);
    }
    blocks.push(
      wrapUntrusted(handoffLines.join('\n'), {
        source: 'memorize.handoff',
        actor: handoff.fromActor,
      }),
    );
  }

  return [
    '# Memorize context',
    '',
    UNTRUSTED_PREAMBLE,
    '',
    blocks.join('\n\n'),
  ].join('\n');
}
