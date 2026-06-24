// tests/integration/benchmark-retrieval-run.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeAll } from '../../src/storage/db.js';
import { seedQuestion } from '../../scripts/benchmarks/retrieval/seed.js';
import { retrieve } from '../../scripts/benchmarks/retrieval/run.js';
import type { BenchQuestion } from '../../scripts/benchmarks/retrieval/dataset.js';

let root: string;
let prevRoot: string | undefined;

beforeEach(() => {
  prevRoot = process.env.MEMORIZE_ROOT;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mz-bench-run-'));
  process.env.MEMORIZE_ROOT = root;
});
afterEach(() => {
  closeAll(); // release SQLite handles before rmSync (Windows EBUSY otherwise)
  if (prevRoot === undefined) delete process.env.MEMORIZE_ROOT;
  else process.env.MEMORIZE_ROOT = prevRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

const Q: BenchQuestion = {
  questionId: 'q1',
  question: 'What did I name my dog?',
  questionType: 'single-session-user',
  sessions: [
    { sessionId: 's0', text: 'user: I went hiking near Boulder.' },
    { sessionId: 's1', text: 'user: We named the dog Max.' },
    { sessionId: 's2', text: 'user: My favorite coffee is a flat white.' },
  ],
  goldSessionIds: ['s1'],
};

describe('benchmark/retrieval run (bm25)', () => {
  it('returns session ids best-first with gold present', async () => {
    const seeded = await seedQuestion(Q, {
      rootPath: path.join(root, 'proj'),
      embed: false,
    });
    const ranked = await retrieve(seeded, Q.question, 'bm25', 20);
    expect(ranked).toContain('s1');
    expect(new Set(ranked).size).toBe(ranked.length); // de-duplicated
  });
});
