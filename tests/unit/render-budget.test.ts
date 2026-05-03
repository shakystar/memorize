import { describe, expect, it } from 'vitest';

import {
  MAX_STARTUP_CONTEXT_CHARS,
  applyRenderBudget,
  type RenderBlock,
} from '../../src/adapters/shared/render-budget.js';

const block = (
  source: string,
  priority: number,
  size: number,
): RenderBlock => ({
  priority,
  source,
  content: 'x'.repeat(size),
});

describe('applyRenderBudget', () => {
  it('keeps every block when total fits within budget', () => {
    const blocks = [
      block('a', 1, 100),
      block('b', 2, 200),
      block('c', 3, 300),
    ];
    const result = applyRenderBudget(blocks, 1000);
    expect(result.kept).toEqual(blocks);
    expect(result.dropped).toEqual([]);
  });

  it('drops lowest-priority blocks first when over budget', () => {
    const blocks = [
      block('topics', 7, 400),
      block('project', 1, 300),
      block('task', 2, 300),
    ];
    const result = applyRenderBudget(blocks, 700);
    expect(result.kept.map((b) => b.source)).toEqual(['project', 'task']);
    expect(result.dropped.map((b) => b.source)).toEqual(['topics']);
  });

  it('stops at first overflow rather than skipping a high-priority block to fit a small low-priority one', () => {
    const blocks = [
      block('project', 1, 100),
      block('task', 2, 7900),
      block('topics', 7, 100),
    ];
    const result = applyRenderBudget(blocks, 1000);
    // task overflows, so topics must also be dropped — we never let
    // a lower-priority block ride along behind a dropped higher one
    expect(result.kept.map((b) => b.source)).toEqual(['project']);
    expect(result.dropped.map((b) => b.source).sort()).toEqual([
      'task',
      'topics',
    ]);
  });

  it('preserves original render order for kept blocks', () => {
    const blocks = [
      block('project', 1, 200),
      block('task', 2, 200),
      block('handoff', 3, 200),
      block('checkpoint', 4, 200),
      block('topics', 7, 200),
    ];
    const result = applyRenderBudget(blocks, 600);
    const sources = result.kept.map((b) => b.source);
    expect(sources).toEqual(['project', 'task', 'handoff']);
  });

  it('always retains the highest-priority block even if it alone exceeds budget', () => {
    const blocks = [
      block('project', 1, 5000),
      block('topics', 7, 100),
    ];
    const result = applyRenderBudget(blocks, 1000);
    expect(result.kept.map((b) => b.source)).toEqual(['project']);
    expect(result.dropped.map((b) => b.source)).toEqual(['topics']);
  });

  it('uses MAX_STARTUP_CONTEXT_CHARS as the default budget', () => {
    const blocks = [block('project', 1, MAX_STARTUP_CONTEXT_CHARS + 1)];
    const result = applyRenderBudget(blocks);
    expect(result.kept).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  it('returns a stable result when blocks list is empty', () => {
    const result = applyRenderBudget([], 100);
    expect(result.kept).toEqual([]);
    expect(result.dropped).toEqual([]);
  });
});
