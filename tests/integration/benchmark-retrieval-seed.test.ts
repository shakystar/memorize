// tests/integration/benchmark-retrieval-seed.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { searchProject } from '../../src/services/search-service.js';
import { listValidMemories } from '../../src/services/projection-store.js';
import { closeAll } from '../../src/storage/db.js';
import { seedQuestion } from '../../scripts/benchmarks/retrieval/seed.js';
import type { BenchQuestion } from '../../scripts/benchmarks/retrieval/dataset.js';

let root: string;
let prevRoot: string | undefined;

beforeEach(() => {
  prevRoot = process.env.MEMORIZE_ROOT;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mz-bench-seed-'));
  process.env.MEMORIZE_ROOT = root;
});

afterEach(() => {
  closeAll();
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
    { sessionId: 's1', text: 'user: We gave the dog the name Max.' },
    { sessionId: 's2', text: 'user: My favorite coffee is a flat white.' },
  ],
  goldSessionIds: ['s1'],
};

describe('benchmark/retrieval seed', () => {
  it('seeds one memory per session, searchable, mapped to session ids', async () => {
    const seeded = await seedQuestion(Q, {
      rootPath: path.join(root, 'proj-q1'),
      embed: false,
    });
    expect(listValidMemories(seeded.projectId)).toHaveLength(3);

    const hits = searchProject(seeded.projectId, 'dog name', 10);
    const sessionIds = hits
      .map((h) => seeded.sessionIdByMemoryId.get(h.entityId))
      .filter(Boolean);
    expect(sessionIds).toContain('s1');
  });
});
