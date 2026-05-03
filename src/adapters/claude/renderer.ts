import type { StartupContextPayload } from '../../domain/entities.js';
import {
  UNTRUSTED_PREAMBLE,
  wrapUntrusted,
} from '../../shared/content-safety.js';
import { buildHandoffRows } from '../shared/handoff-rows.js';

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
    const task = payload.task;
    const taskLines = [
      `Task: ${task.title}`,
      `Goal: ${task.goal}`,
      `Status: ${task.status}`,
      `Priority: ${task.priority}`,
    ];
    if (task.description && task.description !== task.title) {
      taskLines.push(`Description: ${task.description}`);
    }
    if (task.acceptanceCriteria.length > 0) {
      taskLines.push('Acceptance criteria:');
      for (const criterion of task.acceptanceCriteria) {
        taskLines.push(`- ${criterion}`);
      }
    }
    if (task.openQuestions.length > 0) {
      taskLines.push('Open questions:');
      for (const question of task.openQuestions) {
        taskLines.push(`- ${question}`);
      }
    }
    if (task.riskNotes.length > 0) {
      taskLines.push('Risk notes:');
      for (const note of task.riskNotes) {
        taskLines.push(`- ${note}`);
      }
    }
    blocks.push(
      wrapUntrusted(taskLines.join('\n'), { source: 'memorize.task' }),
    );
  }

  if (payload.latestHandoff) {
    const handoff = payload.latestHandoff;
    const [fromRow, ...rest] = buildHandoffRows(handoff);
    const handoffLines = [`Latest handoff: ${fromRow!.value}`];
    for (const row of rest) {
      handoffLines.push(`${row.label}: ${row.value}`);
    }
    blocks.push(
      wrapUntrusted(handoffLines.join('\n'), {
        source: 'memorize.handoff',
        actor: handoff.fromActor,
      }),
    );
  }

  if (payload.openConflicts.length > 0) {
    const conflictLines: string[] = ['Open conflicts:'];
    for (const conflict of payload.openConflicts) {
      conflictLines.push(
        `- [${conflict.conflictType}/${conflict.status}] ${conflict.scopeType}:${conflict.scopeId} @ ${conflict.fieldPath}`,
      );
      conflictLines.push(`  left:  ${conflict.leftVersion}`);
      conflictLines.push(`  right: ${conflict.rightVersion}`);
    }
    blocks.push(
      wrapUntrusted(conflictLines.join('\n'), {
        source: 'memorize.conflicts',
      }),
    );
  }

  if (payload.mustReadTopics.length > 0) {
    const topicLines: string[] = ['Must-read topics:'];
    for (const topic of payload.mustReadTopics) {
      topicLines.push(`- ${topic.title} (${topic.path})`);
    }
    blocks.push(
      wrapUntrusted(topicLines.join('\n'), { source: 'memorize.topics' }),
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
