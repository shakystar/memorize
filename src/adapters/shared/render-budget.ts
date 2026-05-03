/**
 * Renderer block-level character budget. When a startup payload would
 * exceed the budget, we drop blocks in reverse priority order (highest
 * `priority` number first) until the total fits. Project summary lives
 * at priority 1 so it always survives; mustReadTopics sits at the bottom
 * so it gets dropped first.
 *
 * Dropped blocks are reported back to the renderer so it can append a
 * short notice listing what was omitted, giving the agent enough signal
 * to fetch them on demand via projection commands.
 */
export const MAX_STARTUP_CONTEXT_CHARS = 8000;

export interface RenderBlock {
  /** Lower number = higher priority. Priority 1 blocks survive unless the
   *  budget itself is smaller than the priority-1 block, in which case
   *  the renderer should accept the overflow rather than truncate. */
  priority: number;
  /** Short source identifier (e.g. "memorize.task") shown in drop notices. */
  source: string;
  /** Already-wrapped content string measured against the budget. */
  content: string;
}

export interface BudgetResult {
  kept: RenderBlock[];
  dropped: RenderBlock[];
}

export function applyRenderBudget(
  blocks: RenderBlock[],
  budget: number = MAX_STARTUP_CONTEXT_CHARS,
): BudgetResult {
  const totalSize = (entries: readonly RenderBlock[]): number =>
    entries.reduce((sum, b) => sum + b.content.length, 0);

  if (totalSize(blocks) <= budget) {
    return { kept: [...blocks], dropped: [] };
  }

  const indexOf = new Map(blocks.map((b, i) => [b, i]));
  const ranked = [...blocks].sort((a, b) => a.priority - b.priority);
  const kept: RenderBlock[] = [];
  const dropped: RenderBlock[] = [];

  // Strict priority semantics: walk blocks high → low priority and stop
  // at the first block that wouldn't fit. We never skip a high-priority
  // block to make room for a lower-priority one, since that would defeat
  // the ranking. The very top block always survives even if it alone
  // exceeds the budget — agents need at least the project summary.
  let stopped = false;
  for (const block of ranked) {
    if (stopped) {
      dropped.push(block);
      continue;
    }
    if (kept.length === 0) {
      kept.push(block);
      continue;
    }
    if (totalSize([...kept, block]) <= budget) {
      kept.push(block);
    } else {
      dropped.push(block);
      stopped = true;
    }
  }

  kept.sort((a, b) => indexOf.get(a)! - indexOf.get(b)!);
  return { kept, dropped };
}
