// tests/unit/benchmark-retrieval-score.test.ts
import { describe, expect, it } from 'vitest';

import {
  mrr,
  ndcgAtK,
  recallAnyAtK,
  scoreQuestion,
} from '../../scripts/benchmarks/retrieval/score.js';

describe('benchmark/retrieval score', () => {
  const gold = new Set(['s37']);

  it('recallAnyAtK: gold inside top-K is 1, outside is 0', () => {
    const ranked = ['s12', 's37', 's5', 's88', 's2'];
    expect(recallAnyAtK(ranked, gold, 1)).toBe(0); // s37 is rank 2
    expect(recallAnyAtK(ranked, gold, 2)).toBe(1);
    expect(recallAnyAtK(ranked, gold, 5)).toBe(1);
    expect(recallAnyAtK([], gold, 5)).toBe(0);
  });

  it('mrr: reciprocal rank of first gold (rank 2 -> 0.5)', () => {
    expect(mrr(['s12', 's37', 's5'], gold)).toBeCloseTo(0.5, 10);
    expect(mrr(['s37'], gold)).toBe(1);
    expect(mrr(['s1', 's2'], gold)).toBe(0);
  });

  it('ndcgAtK: single gold at rank 2 -> 1/log2(3) normalized to ideal 1.0', () => {
    // ideal puts the one gold at rank 1 (idcg = 1/log2(2) = 1)
    // dcg = 1/log2(2+1) = 1/log2(3)
    expect(ndcgAtK(['s12', 's37'], gold, 10)).toBeCloseTo(1 / Math.log2(3), 10);
    expect(ndcgAtK(['s37'], gold, 10)).toBeCloseTo(1, 10);
    expect(ndcgAtK(['s1'], gold, 10)).toBe(0);
  });

  it('scoreQuestion bundles all metrics for the requested Ks', () => {
    const s = scoreQuestion(['s12', 's37', 's5'], ['s37'], [1, 5]);
    expect(s.recallAtK).toEqual({ 1: 0, 5: 1 });
    expect(s.mrr).toBeCloseTo(0.5, 10);
    expect(s.ndcg10).toBeCloseTo(1 / Math.log2(3), 10);
  });
});
