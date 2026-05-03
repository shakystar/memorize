import type { StartupContextPayload } from '../../domain/entities.js';
import {
  UNTRUSTED_PREAMBLE,
  wrapUntrusted,
} from '../../shared/content-safety.js';
import { buildHandoffRows } from '../shared/handoff-rows.js';

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
    const handoffLines = ['## Latest handoff'];
    for (const row of buildHandoffRows(handoff)) {
      handoffLines.push(`- ${row.label}: ${row.value}`);
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

  if (payload.otherActiveTasks && payload.otherActiveTasks.length > 0) {
    const otherLines: string[] = ['## Other active tasks'];
    for (const entry of payload.otherActiveTasks) {
      otherLines.push(
        `- ${entry.id}: "${entry.title}" — ${entry.assignment.actor}, ${entry.assignment.freshness}`,
      );
    }
    blocks.push(
      wrapUntrusted(otherLines.join('\n'), {
        source: 'memorize.other-active-tasks',
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
