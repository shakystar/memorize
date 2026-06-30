import type { LiveUpdate, StartupContextPayload } from '../../domain/entities.js';
import {
  GROUND_RULE_LINE,
  UNTRUSTED_PREAMBLE,
  wrapUntrusted,
} from '../../shared/content-safety.js';
import { buildHandoffRows } from '../shared/handoff-rows.js';
import { renderLiveUpdateBlocks } from '../shared/live-update.js';
import {
  type RenderBlock,
  applyRenderBudget,
} from '../shared/render-budget.js';

export interface RenderOptions {
  /** Override the character budget (default MAX_STARTUP_CONTEXT_CHARS).
   *  Exposed mainly so tests can exercise drop behavior without padding
   *  payloads to many kilobytes. */
  budget?: number;
}

export function renderClaudeStartupContext(
  payload: StartupContextPayload,
  options: RenderOptions = {},
): string {
  const blocks: RenderBlock[] = [];

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
  blocks.push({
    priority: 1,
    source: 'memorize.project',
    content: wrapUntrusted(projectLines.join('\n'), {
      source: 'memorize.project',
    }),
  });

  if (payload.consolidatedMemories && payload.consolidatedMemories.length > 0) {
    const memoryLines: string[] = ['Consolidated memories:'];
    for (const memory of payload.consolidatedMemories) {
      memoryLines.push(`- [${memory.kind}/s${memory.salience}] ${memory.text}`);
    }
    blocks.push({
      priority: 2,
      source: 'memorize.memories',
      content: wrapUntrusted(memoryLines.join('\n'), {
        source: 'memorize.memories',
      }),
    });
  }

  if (payload.personalMemories && payload.personalMemories.length > 0) {
    const personalLines: string[] = [
      'Personal memory (cross-project; your preferences & working style):',
    ];
    for (const memory of payload.personalMemories) {
      personalLines.push(`- [${memory.kind}/s${memory.salience}] ${memory.text}`);
    }
    // Priority 2.2: just below the project memory pool (2), above the
    // observation tail (2.5) — a distinct, high-value channel that does not
    // compete with project memories for the same slot.
    blocks.push({
      priority: 2.2,
      source: 'memorize.personal',
      content: wrapUntrusted(personalLines.join('\n'), {
        source: 'memorize.personal',
      }),
    });
  }

  if (payload.recentObservations && payload.recentObservations.length > 0) {
    const observationLines: string[] = ['Recent work signals (prior session tail):'];
    for (const observation of payload.recentObservations) {
      observationLines.push(
        `- [${observation.signal}${observation.toolName ? `/${observation.toolName}` : ''}] ${observation.summary ?? observation.createdAt}`,
      );
    }
    blocks.push({
      priority: 2.5,
      source: 'memorize.observations',
      content: wrapUntrusted(observationLines.join('\n'), {
        source: 'memorize.observations',
      }),
    });
  }

  if (payload.rawSegments && payload.rawSegments.length > 0) {
    const segmentLines: string[] = ['Raw session detail (retrieved for this task):'];
    for (const seg of payload.rawSegments) segmentLines.push(seg.text);
    // Low priority: drops before memories/observations/task under budget pressure
    // so the augmentative raw detail can never evict the consolidated layer.
    blocks.push({
      priority: 6.5,
      source: 'memorize.segments',
      content: wrapUntrusted(segmentLines.join('\n\n'), {
        source: 'memorize.segments',
      }),
    });
  }

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
    blocks.push({
      priority: 3,
      source: 'memorize.task',
      content: wrapUntrusted(taskLines.join('\n'), { source: 'memorize.task' }),
    });
  }

  if (payload.latestHandoff) {
    const handoff = payload.latestHandoff;
    const [fromRow, ...rest] = buildHandoffRows(handoff);
    const handoffLines = [`Latest handoff: ${fromRow!.value}`];
    for (const row of rest) {
      handoffLines.push(`${row.label}: ${row.value}`);
    }
    blocks.push({
      priority: 4,
      source: 'memorize.handoff',
      content: wrapUntrusted(handoffLines.join('\n'), {
        source: 'memorize.handoff',
        actor: handoff.fromActor,
      }),
    });
  }

  if (payload.latestCheckpoint) {
    const checkpoint = payload.latestCheckpoint;
    const checkpointLines: string[] = [
      `Latest compact summary: ${checkpoint.summary}`,
    ];
    if (checkpoint.deferredItems.length > 0) {
      checkpointLines.push('Deferred items:');
      for (const item of checkpoint.deferredItems) {
        checkpointLines.push(`- ${item}`);
      }
    }
    blocks.push({
      priority: 5,
      source: 'memorize.checkpoint',
      content: wrapUntrusted(checkpointLines.join('\n'), {
        source: 'memorize.checkpoint',
      }),
    });
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
    blocks.push({
      priority: 5.5,
      source: 'memorize.conflicts',
      content: wrapUntrusted(conflictLines.join('\n'), {
        source: 'memorize.conflicts',
      }),
    });
  }

  if (payload.otherActiveTasks && payload.otherActiveTasks.length > 0) {
    const otherLines: string[] = ['Other active tasks:'];
    for (const entry of payload.otherActiveTasks) {
      otherLines.push(
        `- ${entry.id}: "${entry.title}" (${entry.assignment.actor}, ${entry.assignment.freshness})`,
      );
    }
    blocks.push({
      priority: 6,
      source: 'memorize.other-active-tasks',
      content: wrapUntrusted(otherLines.join('\n'), {
        source: 'memorize.other-active-tasks',
      }),
    });
  }

  if (payload.mustReadTopics.length > 0) {
    const topicLines: string[] = ['Must-read topics:'];
    for (const topic of payload.mustReadTopics) {
      topicLines.push(`- ${topic.title} (${topic.path})`);
    }
    blocks.push({
      priority: 7,
      source: 'memorize.topics',
      content: wrapUntrusted(topicLines.join('\n'), {
        source: 'memorize.topics',
      }),
    });
  }

  const { kept, dropped } = applyRenderBudget(blocks, options.budget);
  const renderedBlocks = kept.map((b) => b.content);
  if (dropped.length > 0) {
    const droppedSources = dropped.map((b) => b.source).join(', ');
    renderedBlocks.push(
      wrapUntrusted(
        `Sections dropped to fit budget: ${droppedSources}\nFetch via memorize projection commands when needed.`,
        { source: 'memorize.budget-notice' },
      ),
    );
  }

  return [
    '# Memorize context',
    '',
    UNTRUSTED_PREAMBLE,
    '',
    GROUND_RULE_LINE,
    '',
    renderedBlocks.join('\n\n'),
  ].join('\n');
}

export function renderClaudeLiveUpdate(update: LiveUpdate): string {
  return renderLiveUpdateBlocks(update, {
    heading: '# Memorize live update (parallel sessions)',
  });
}
