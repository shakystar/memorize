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

  it('captures the gold answer and abstention flag', () => {
    const qs = loadDataset(MINI);
    const q1 = qs[0]!;
    expect(q1.answer).toBe('Max'); // mini fixture q1 answer
    expect(q1.isAbstention).toBe(false);
  });

  it('flags abstention by _abs question id and coerces a numeric answer to string', () => {
    const parsed = parseDataset([
      {
        question_id: 'q_abs',
        question_type: 'single-session-user',
        question: 'unanswerable?',
        haystack_session_ids: ['s0'],
        haystack_sessions: [[{ role: 'user', content: 'hi' }]],
        answer_session_ids: [],
        answer: 42,
      },
    ]);
    expect(parsed[0]!.isAbstention).toBe(true);
    expect(parsed[0]!.answer).toBe('42');
  });

  it('nulls an answer that is neither string nor number', () => {
    const parsed = parseDataset([
      {
        question_id: 'q1',
        question_type: 'single-session-user',
        question: 'something?',
        haystack_session_ids: ['s0'],
        haystack_sessions: [[{ role: 'user', content: 'hi' }]],
        answer_session_ids: [],
        answer: null,
      },
    ]);
    expect(parsed[0]!.answer).toBeNull();
  });
});
