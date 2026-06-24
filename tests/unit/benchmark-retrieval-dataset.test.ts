// tests/unit/benchmark-retrieval-dataset.test.ts
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadDataset, parseDataset } from '../../scripts/benchmarks/retrieval/dataset.js';

const MINI = path.join(
  process.cwd(),
  'scripts/benchmarks/retrieval/fixtures/mini-longmemeval.json',
);

describe('benchmark/retrieval dataset', () => {
  it('loads the committed mini fixture into BenchQuestion[]', () => {
    const qs = loadDataset(MINI);
    expect(qs).toHaveLength(5);
    const q1 = qs[0]!;
    expect(q1.questionId).toBe('q1');
    expect(q1.questionType).toBe('single-session-user');
    expect(q1.sessions).toHaveLength(3);
    expect(q1.goldSessionIds).toEqual(['q1-s1']);
    // turns are flattened into one text block containing the answer evidence
    expect(q1.sessions[1]!.text).toContain('named the dog Max');
  });

  it('parseDataset throws a descriptive error on a missing field', () => {
    expect(() => parseDataset([{ question_id: 'x' }])).toThrow(/answer_session_ids|haystack/);
  });
});
