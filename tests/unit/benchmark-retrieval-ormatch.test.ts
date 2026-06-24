import { describe, expect, it } from 'vitest';

import { toOrMatch } from '../../scripts/benchmarks/retrieval/run.js';

describe('benchmark/retrieval toOrMatch', () => {
  it('joins tokens with OR, each a quoted FTS5 string', () => {
    expect(toOrMatch('dog name')).toBe('"dog" OR "name"');
  });
  it('doubles embedded quotes (injection-safe)', () => {
    expect(toOrMatch('a"b c')).toBe('"a""b" OR "c"');
  });
  it('returns undefined for empty / punctuation-only queries', () => {
    expect(toOrMatch('   ')).toBeUndefined();
    expect(toOrMatch('!!! ???')).toBeUndefined();
  });
});
