import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConsolidatedMemory } from '../../src/domain/entities.js';
import {
  detectContradictions,
  type Judge,
} from '../../src/services/contradiction-service.js';
import { ensureEmbeddings, type Embedder } from '../../src/services/embeddings-service.js';
import { createProject } from '../../src/services/project-service.js';
import {
  listOpenConflicts,
  listValidMemories,
  rebuildProjectProjection,
} from '../../src/services/projection-store.js';
import { closeAll } from '../../src/storage/db.js';
import { appendEvent } from '../../src/storage/event-store.js';

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-contradiction-'));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  delete process.env.MEMORIZE_EMBEDDINGS_ENDPOINT;
  delete process.env.MEMORIZE_EMBEDDINGS_API_KEY;
  delete process.env.MEMORIZE_LLM_API_KEY;
  await rm(sandbox, { recursive: true, force: true });
});

const SQLITE = 'The project database is SQLite';
const POSTGRES = 'The project database is PostgreSQL';
const UI = 'The frontend framework is React';
// Same-topic pairs get near-identical vectors (cosine ~1 ≥ 0.82 threshold).
const VECTORS: Record<string, number[]> = {
  [SQLITE]: [1, 0, 0],
  [POSTGRES]: [0.99, 0.01, 0],
  [UI]: [0, 1, 0],
};

function fakeEmbedder(model = 'fake-embed-v1'): Embedder {
  return {
    model,
    embed: (texts) => Promise.resolve(texts.map((t) => VECTORS[t] ?? [0, 0, 0])),
  };
}

const yesJudge: Judge = (pairs) =>
  Promise.resolve(
    pairs.map((p) => ({
      aId: p.aId,
      bId: p.bId,
      contradicts: true,
      topic: 'database engine',
    })),
  );

const noJudge: Judge = (pairs) =>
  Promise.resolve(
    pairs.map((p) => ({ aId: p.aId, bId: p.bId, contradicts: false })),
  );

async function seedDecision(
  projectId: string,
  text: string,
  opts: { createdAt: string; sessionId?: string },
): Promise<string> {
  const memory = {
    ...createConsolidatedMemory({
      projectId,
      kind: 'decision',
      text,
      salience: 7,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      sourceObservationIds: [],
    }),
    createdAt: opts.createdAt,
  };
  await appendEvent({
    type: 'memory.consolidated',
    projectId,
    scopeType: 'session',
    scopeId: opts.sessionId ?? projectId,
    actor: 'test',
    payload: memory,
  });
  return memory.id;
}

const EARLY = '2026-06-08T00:00:00.000Z';
const LATE = '2026-06-08T05:00:00.000Z';

describe('semantic contradiction detection (P3-c round 2)', () => {
  it('supersedes the older decision and raises a conflict (newer wins)', async () => {
    const project = await createProject({ title: 'C', rootPath: join(sandbox, 'p') });
    const idOld = await seedDecision(project.id, SQLITE, { createdAt: EARLY });
    const idNew = await seedDecision(project.id, POSTGRES, { createdAt: LATE });
    await rebuildProjectProjection(project.id);
    const embedder = fakeEmbedder();
    await ensureEmbeddings(project.id, { embedder });

    const result = await detectContradictions(project.id, {
      actor: 'test',
      embedder,
      judge: yesJudge,
    });
    expect(result.detected).toBe(1);

    const validIds = listValidMemories(project.id).map((r) => r.memory.id);
    expect(validIds).toContain(idNew); // newer = current truth
    expect(validIds).not.toContain(idOld); // older superseded (non-destructive)

    const conflicts = listOpenConflicts(project.id);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.rightVersion).toBe(POSTGRES); // winner
    expect(conflicts[0]!.leftVersion).toBe(SQLITE); // loser
    expect(conflicts[0]!.conflictType).toBe('decision');
    expect(conflicts[0]!.concurrent).toBeFalsy(); // same (absent) session
  });

  it('ignores topically-similar pairs the judge says do NOT contradict', async () => {
    const project = await createProject({ title: 'C', rootPath: join(sandbox, 'p') });
    await seedDecision(project.id, SQLITE, { createdAt: EARLY });
    await seedDecision(project.id, POSTGRES, { createdAt: LATE });
    await rebuildProjectProjection(project.id);
    const embedder = fakeEmbedder();
    await ensureEmbeddings(project.id, { embedder });

    const result = await detectContradictions(project.id, {
      actor: 'test',
      embedder,
      judge: noJudge,
    });
    expect(result.detected).toBe(0);
    expect(listValidMemories(project.id)).toHaveLength(2);
    expect(listOpenConflicts(project.id)).toHaveLength(0);
  });

  it('does not pair dissimilar decisions (below cosine threshold)', async () => {
    const project = await createProject({ title: 'C', rootPath: join(sandbox, 'p') });
    await seedDecision(project.id, SQLITE, { createdAt: EARLY });
    await seedDecision(project.id, UI, { createdAt: LATE }); // orthogonal vector
    await rebuildProjectProjection(project.id);
    const embedder = fakeEmbedder();
    await ensureEmbeddings(project.id, { embedder });

    // yesJudge would say contradicts, but no candidate pair forms (cosine 0).
    const result = await detectContradictions(project.id, {
      actor: 'test',
      embedder,
      judge: yesJudge,
    });
    expect(result.detected).toBe(0);
    expect(listOpenConflicts(project.id)).toHaveLength(0);
  });

  it('tags concurrent forks (different sessions)', async () => {
    const project = await createProject({ title: 'C', rootPath: join(sandbox, 'p') });
    await seedDecision(project.id, SQLITE, { createdAt: EARLY, sessionId: 'sess_a' });
    await seedDecision(project.id, POSTGRES, { createdAt: LATE, sessionId: 'sess_b' });
    await rebuildProjectProjection(project.id);
    const embedder = fakeEmbedder();
    await ensureEmbeddings(project.id, { embedder });

    await detectContradictions(project.id, { actor: 'test', embedder, judge: yesJudge });
    const conflicts = listOpenConflicts(project.id);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.concurrent).toBe(true);
  });

  it('is idempotent — a second pass finds nothing new', async () => {
    const project = await createProject({ title: 'C', rootPath: join(sandbox, 'p') });
    await seedDecision(project.id, SQLITE, { createdAt: EARLY });
    await seedDecision(project.id, POSTGRES, { createdAt: LATE });
    await rebuildProjectProjection(project.id);
    const embedder = fakeEmbedder();
    await ensureEmbeddings(project.id, { embedder });

    expect((await detectContradictions(project.id, { actor: 'test', embedder, judge: yesJudge })).detected).toBe(1);
    // Loser is now superseded → fewer than 2 valid decisions → no-op.
    expect((await detectContradictions(project.id, { actor: 'test', embedder, judge: yesJudge })).detected).toBe(0);
    expect(listOpenConflicts(project.id)).toHaveLength(1);
  });

  it('is a no-op when the embedder or the judge is missing (gate)', async () => {
    const project = await createProject({ title: 'C', rootPath: join(sandbox, 'p') });
    await seedDecision(project.id, SQLITE, { createdAt: EARLY });
    await seedDecision(project.id, POSTGRES, { createdAt: LATE });
    await rebuildProjectProjection(project.id);
    await ensureEmbeddings(project.id, { embedder: fakeEmbedder() });

    // No embedder configured (env unset) even though a judge is supplied.
    expect(
      (await detectContradictions(project.id, { actor: 'test', judge: yesJudge })).detected,
    ).toBe(0);
    // Embedder present but no judge (no LLM env) → no-op.
    expect(
      (await detectContradictions(project.id, { actor: 'test', embedder: fakeEmbedder() })).detected,
    ).toBe(0);
    expect(listOpenConflicts(project.id)).toHaveLength(0);
  });

  it('never throws when the judge fails', async () => {
    const project = await createProject({ title: 'C', rootPath: join(sandbox, 'p') });
    await seedDecision(project.id, SQLITE, { createdAt: EARLY });
    await seedDecision(project.id, POSTGRES, { createdAt: LATE });
    await rebuildProjectProjection(project.id);
    const embedder = fakeEmbedder();
    await ensureEmbeddings(project.id, { embedder });

    const boomJudge: Judge = () => Promise.reject(new Error('judge down'));
    const result = await detectContradictions(project.id, {
      actor: 'test',
      embedder,
      judge: boomJudge,
    });
    expect(result.detected).toBe(0);
    expect(listValidMemories(project.id)).toHaveLength(2); // nothing superseded
  });
});
