import type { LiveUpdate } from '../../domain/entities.js';
import { UNTRUSTED_PREAMBLE, wrapUntrusted } from '../../shared/content-safety.js';
import {
  LIVE_UPDATE_BUDGET_CHARS,
  type RenderBlock,
  applyRenderBudget,
} from './render-budget.js';

/**
 * CLS Phase 2 — shared live-update renderer (claude + codex differ only in the
 * top heading). Sibling content is UNTRUSTED (another agent's file paths /
 * commit messages could carry injection), so every block is wrapped exactly
 * like startup blocks. Priority order conflicts → memories → observations; the
 * char budget is the small per-tool-call LIVE_UPDATE budget, not the startup
 * one (the two never co-occur — PostToolUse vs SessionStart).
 */
export function renderLiveUpdateBlocks(
  update: LiveUpdate,
  opts: { heading: string; budget?: number },
): string {
  const budget = opts.budget ?? LIVE_UPDATE_BUDGET_CHARS;
  const blocks: RenderBlock[] = [];

  if (update.gitOpWarnings.length > 0) {
    const lines: string[] = [
      'Parallel destructive git activity — serialize, do not run concurrently:',
    ];
    for (const warning of update.gitOpWarnings) {
      lines.push(
        `- ⚠ session ${warning.siblingSessionId} (${warning.siblingActor}): ${warning.command}`,
      );
    }
    blocks.push({
      priority: 0,
      source: 'memorize.live.gitops',
      content: wrapUntrusted(lines.join('\n'), {
        source: 'memorize.live.gitops',
      }),
    });
  }

  if (update.conflicts.length > 0) {
    const lines: string[] = ['File overlap with parallel sessions:'];
    for (const conflict of update.conflicts) {
      lines.push(
        `- ⚠ ${conflict.filePath} also touched by session ${conflict.siblingSessionId} (${conflict.siblingActor})`,
      );
    }
    blocks.push({
      priority: 1,
      source: 'memorize.live.conflicts',
      content: wrapUntrusted(lines.join('\n'), {
        source: 'memorize.live.conflicts',
      }),
    });
  }

  if (update.memories.length > 0) {
    const lines: string[] = ['Sibling decisions/memories:'];
    for (const memory of update.memories) {
      lines.push(`- [${memory.kind}/s${memory.salience}] ${memory.text}`);
    }
    blocks.push({
      priority: 2,
      source: 'memorize.live.memories',
      content: wrapUntrusted(lines.join('\n'), {
        source: 'memorize.live.memories',
      }),
    });
  }

  if (update.observations.length > 0) {
    const lines: string[] = ['Sibling work signals (live):'];
    for (const obs of update.observations) {
      lines.push(
        `- [${obs.signal}${obs.toolName ? `/${obs.toolName}` : ''} @${obs.sessionId}] ${obs.summary ?? obs.createdAt}`,
      );
    }
    blocks.push({
      priority: 3,
      source: 'memorize.live.observations',
      content: wrapUntrusted(lines.join('\n'), {
        source: 'memorize.live.observations',
      }),
    });
  }

  const { kept } = applyRenderBudget(blocks, budget);
  return [opts.heading, '', UNTRUSTED_PREAMBLE, '', kept.map((b) => b.content).join('\n\n')].join(
    '\n',
  );
}
