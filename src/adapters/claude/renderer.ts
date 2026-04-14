import type { StartupContextPayload } from '../../domain/entities.js';
import {
  UNTRUSTED_PREAMBLE,
  wrapUntrusted,
} from '../../shared/content-safety.js';

export function renderClaudeStartupContext(
  payload: StartupContextPayload,
): string {
  const untrustedLines: string[] = [];

  untrustedLines.push(`Project: ${payload.projectSummary}`);

  if (payload.projectRules.length > 0) {
    untrustedLines.push('Rules:');
    for (const rule of payload.projectRules) {
      untrustedLines.push(`- ${rule}`);
    }
  }

  if (payload.workstreamSummary) {
    untrustedLines.push(`Workstream: ${payload.workstreamSummary}`);
  }

  if (payload.task) {
    untrustedLines.push(`Task: ${payload.task.title}`);
    untrustedLines.push(`Goal: ${payload.task.goal}`);
    untrustedLines.push(`Status: ${payload.task.status}`);
  }

  if (payload.latestHandoff) {
    const handoff = payload.latestHandoff;
    untrustedLines.push(`Latest handoff: ${handoff.fromActor} → ${handoff.toActor}`);
    if (handoff.fromActor === 'user') {
      untrustedLines.push(
        '(user-authored intent — verify code/test state independently before trusting claims)',
      );
    }
    untrustedLines.push(`Handoff summary: ${handoff.summary}`);
    untrustedLines.push(`Next action: ${handoff.nextAction}`);
    if (handoff.remainingItems.length > 0) {
      untrustedLines.push(`Remaining: ${handoff.remainingItems.join('; ')}`);
    }
  }

  const body = wrapUntrusted(untrustedLines.join('\n'), {
    source: 'memorize.startup',
  });

  return ['# Memorize context', '', UNTRUSTED_PREAMBLE, '', body].join('\n');
}
