// tests/unit/benchmark-e2e-score.test.ts
import { describe, expect, it } from 'vitest';

import { aggregate } from '../../scripts/benchmarks/e2e/score-e2e.js';
import { renderTable } from '../../scripts/benchmarks/e2e/report-e2e.js';

describe('benchmark/e2e scoring', () => {
  const results = [
    { questionType: 'a', isAbstention: false, correct: true },
    { questionType: 'a', isAbstention: false, correct: false },
    { questionType: 'b', isAbstention: true, correct: true },
  ];

  it('computes overall, per-type, and abstention accuracy', () => {
    const r = aggregate(results);
    expect(r.overall.n).toBe(3);
    expect(r.overall.accuracy).toBeCloseTo(2 / 3, 10);
    expect(r.byType.find((t) => t.label === 'a')!.accuracy).toBeCloseTo(0.5, 10);
    expect(r.abstention.n).toBe(1);
    expect(r.abstention.accuracy).toBeCloseTo(1, 10);
  });

  it('renders a table with the headline rows and skip count', () => {
    const out = renderTable({ ...aggregate(results), skipped: 4 });
    expect(out).toContain('overall');
    expect(out).toContain('abstention');
    expect(out).toContain('accuracy');
    expect(out).toContain('skipped 4');
  });

  it('renders - for accuracy when abstention row has n=0', () => {
    const noAbstentionResults = [
      { questionType: 'a', isAbstention: false, correct: true },
      { questionType: 'a', isAbstention: false, correct: false },
    ];
    const out = renderTable({ ...aggregate(noAbstentionResults), skipped: 0 });
    expect(out).toContain('abstention\t0\t-');
  });
});
