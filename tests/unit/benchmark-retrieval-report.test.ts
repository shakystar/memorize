// tests/unit/benchmark-retrieval-report.test.ts
import { describe, expect, it } from 'vitest';

import { aggregate, renderTable } from '../../scripts/benchmarks/retrieval/report.js';

const ks = [1, 5];

describe('benchmark/retrieval report', () => {
  const scored = [
    { questionType: 'a', score: { recallAtK: { 1: 1, 5: 1 }, mrr: 1, ndcg10: 1 } },
    { questionType: 'a', score: { recallAtK: { 1: 0, 5: 1 }, mrr: 0.5, ndcg10: 0.5 } },
    { questionType: 'b', score: { recallAtK: { 1: 0, 5: 0 }, mrr: 0, ndcg10: 0 } },
  ];

  it('aggregates overall and per type as means', () => {
    const r = aggregate(scored, ks);
    expect(r.overall.count).toBe(3);
    expect(r.overall.recallAtK[1]).toBeCloseTo(1 / 3, 10);
    expect(r.overall.recallAtK[5]).toBeCloseTo(2 / 3, 10);
    expect(r.overall.mrr).toBeCloseTo(0.5, 10);
    const a = r.byType.find((t) => t.label === 'a')!;
    expect(a.count).toBe(2);
    expect(a.recallAtK[5]).toBeCloseTo(1, 10);
  });

  it('renders a table containing the headline metrics', () => {
    const out = renderTable(aggregate(scored, ks), ks);
    expect(out).toContain('recall@5');
    expect(out).toContain('overall');
  });
});
