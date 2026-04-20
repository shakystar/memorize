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
    const task = payload.task;
    const taskLines: string[] = [
      '## Current task',
      `- Title: ${task.title}`,
      `- Goal: ${task.goal}`,
      `- Status: ${task.status}`,
      `- Priority: ${task.priority}`,
    ];
    if (task.description && task.description !== task.title) {
      taskLines.push(`- Description: ${task.description}`);
    }
    if (task.acceptanceCriteria.length > 0) {
      taskLines.push('- Acceptance criteria:');
      for (const criterion of task.acceptanceCriteria) {
        taskLines.push(`  - ${criterion}`);
      }
    }
    if (task.openQuestions.length > 0) {
      taskLines.push('- Open questions:');
      for (const question of task.openQuestions) {
        taskLines.push(`  - ${question}`);
      }
    }
    if (task.riskNotes.length > 0) {
      taskLines.push('- Risk notes:');
      for (const note of task.riskNotes) {
        taskLines.push(`  - ${note}`);
      }
    }
    blocks.push(
      wrapUntrusted(taskLines.join('\n'), { source: 'memorize.task' }),
    );
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
      `- Confidence: ${handoff.confidence}`,
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
    if (handoff.unresolvedQuestions.length > 0) {
      handoffLines.push(
        `- Unresolved questions: ${handoff.unresolvedQuestions.join('; ')}`,
      );
    }
    blocks.push(
      wrapUntrusted(handoffLines.join('\n'), {
        source: 'memorize.handoff',
        actor: handoff.fromActor,
      }),
    );
  }

  if (payload.openConflicts.length > 0) {
    const conflictLines: string[] = ['## Open conflicts'];
    for (const conflict of payload.openConflicts) {
      conflictLines.push(
        `- [${conflict.conflictType}/${conflict.status}] ${conflict.scopeType}:${conflict.scopeId} @ ${conflict.fieldPath}`,
      );
      conflictLines.push(`  - left: ${conflict.leftVersion}`);
      conflictLines.push(`  - right: ${conflict.rightVersion}`);
    }
    blocks.push(
      wrapUntrusted(conflictLines.join('\n'), {
        source: 'memorize.conflicts',
      }),
    );
  }

  if (payload.mustReadTopics.length > 0) {
    const topicLines: string[] = ['## Must-read topics'];
    for (const topic of payload.mustReadTopics) {
      topicLines.push(`- ${topic.title} (${topic.path})`);
    }
    blocks.push(
      wrapUntrusted(topicLines.join('\n'), { source: 'memorize.topics' }),
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
