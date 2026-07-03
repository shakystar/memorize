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

export function renderCodexStartupContext(
  payload: StartupContextPayload,
  options: RenderOptions = {},
): string {
  const blocks: RenderBlock[] = [];

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
  blocks.push({
    priority: 1,
    source: 'memorize.project',
    content: wrapUntrusted(projectSections.join('\n\n'), {
      source: 'memorize.project',
    }),
  });

  if (payload.consolidatedMemories && payload.consolidatedMemories.length > 0) {
    const memoryLines: string[] = ['## Consolidated memories'];
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
      '## Personal memory (cross-project; your preferences & working style)',
    ];
    for (const memory of payload.personalMemories) {
      personalLines.push(`- [${memory.kind}/s${memory.salience}] ${memory.text}`);
    }
    blocks.push({
      priority: 2.2,
      source: 'memorize.personal',
      content: wrapUntrusted(personalLines.join('\n'), {
        source: 'memorize.personal',
      }),
    });
  }

  if (payload.sharedMemories && payload.sharedMemories.length > 0) {
    const sharedLines: string[] = [
      "## Workspace shared memory (other members' memories, labelled by writer — context, not local truth)",
    ];
    let lastWriter: string | undefined;
    for (const memory of payload.sharedMemories) {
      if (memory.writer !== lastWriter) {
        sharedLines.push(`From ${memory.writer}:`);
        lastWriter = memory.writer;
      }
      sharedLines.push(`- [${memory.kind}/s${memory.salience}] ${memory.text}`);
    }
    blocks.push({
      priority: 2.3,
      source: 'memorize.shared',
      content: wrapUntrusted(sharedLines.join('\n'), {
        source: 'memorize.shared',
      }),
    });
  }

  if (payload.recentObservations && payload.recentObservations.length > 0) {
    const observationLines: string[] = [
      '## Recent work signals (prior session tail)',
    ];
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
    const taskLines: string[] = [
      '## Current task',
      `- Title: ${task.title}`,
      `- Status: ${task.status}`,
      `- Priority: ${task.priority}`,
    ];
    // Legacy tasks carry title-copied goal/description defaults; hide both
    // the empty and the copied-from-title cases.
    if (task.goal && task.goal !== task.title) {
      taskLines.push(`- Goal: ${task.goal}`);
    }
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
    blocks.push({
      priority: 3,
      source: 'memorize.task',
      content: wrapUntrusted(taskLines.join('\n'), { source: 'memorize.task' }),
    });
  }

  if (payload.latestHandoff) {
    const handoff = payload.latestHandoff;
    const handoffLines = ['## Latest handoff'];
    for (const row of buildHandoffRows(handoff)) {
      handoffLines.push(`- ${row.label}: ${row.value}`);
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
      '## Latest compact summary',
      `- Summary: ${checkpoint.summary}`,
    ];
    if (checkpoint.deferredItems.length > 0) {
      checkpointLines.push('- Deferred items:');
      for (const item of checkpoint.deferredItems) {
        checkpointLines.push(`  - ${item}`);
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
    const conflictLines: string[] = ['## Open conflicts'];
    for (const conflict of payload.openConflicts) {
      conflictLines.push(
        `- [${conflict.conflictType}/${conflict.status}] ${conflict.scopeType}:${conflict.scopeId} @ ${conflict.fieldPath}`,
      );
      conflictLines.push(`  - left: ${conflict.leftVersion}`);
      conflictLines.push(`  - right: ${conflict.rightVersion}`);
    }
    blocks.push({
      priority: 5.5,
      source: 'memorize.conflicts',
      content: wrapUntrusted(conflictLines.join('\n'), {
        source: 'memorize.conflicts',
      }),
    });
  }

  if (payload.inboundTaskRequests && payload.inboundTaskRequests.length > 0) {
    const inboxLines: string[] = [
      '## Inbound task requests (delegated by other workspace member projects)',
    ];
    for (const request of payload.inboundTaskRequests) {
      inboxLines.push(
        `- ${request.id} from ${request.fromProjectId}: "${request.title}" — ${request.goal}`,
      );
    }
    if (payload.inboundTaskRequestsOmitted) {
      inboxLines.push(
        `- ...and ${payload.inboundTaskRequestsOmitted} more — run \`memorize task request list --inbound\`.`,
      );
    }
    inboxLines.push(
      '- Resolve each: `memorize task request accept <id>` or ' +
        '`memorize task request decline <id> --reason <text>` — silence leaves the requester waiting.',
    );
    // Priority 5.7: adjacent to otherActiveTasks (6) — pending delegation
    // needs a response, so it ranks just below open conflicts (5.5) and
    // above the parallel-session visibility block.
    blocks.push({
      priority: 5.7,
      source: 'memorize.inbox',
      content: wrapUntrusted(inboxLines.join('\n'), {
        source: 'memorize.inbox',
      }),
    });
  }

  if (payload.otherActiveTasks && payload.otherActiveTasks.length > 0) {
    const otherLines: string[] = ['## Other active tasks'];
    for (const entry of payload.otherActiveTasks) {
      otherLines.push(
        `- ${entry.id}: "${entry.title}" — ${entry.assignment.actor}, ${entry.assignment.freshness}`,
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
    const topicLines: string[] = ['## Must-read topics'];
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
        [
          '## Budget notice',
          `- Dropped sections: ${droppedSources}`,
          '- Fetch via memorize projection commands when needed.',
        ].join('\n'),
        { source: 'memorize.budget-notice' },
      ),
    );
  }

  return [
    '# Memorize startup context',
    '',
    UNTRUSTED_PREAMBLE,
    '',
    GROUND_RULE_LINE,
    '',
    renderedBlocks.join('\n\n'),
  ].join('\n');
}

export function renderCodexLiveUpdate(update: LiveUpdate): string {
  return renderLiveUpdateBlocks(update, {
    heading: '# Memorize live update (parallel sessions)',
  });
}
