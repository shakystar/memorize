import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConsolidatedMemory } from '../../src/domain/entities.js';
import type { ConsolidatedMemoryKind } from '../../src/domain/entities/memory.js';
import {
  cosineSimilarity,
  ensureEmbeddings,
  reciprocalRankFusion,
  resolveEmbeddingsConfig,
  type Embedder,
} from '../../src/services/embeddings-service.js';
import {
  getEmbedding,
  listEmbeddings,
} from '../../src/services/embeddings-store.js';
import { createProject } from '../../src/services/project-service.js';
import { rebuildProjectProjection } from '../../src/services/projection-store.js';
import {
  hybridSearch,
  searchProject,
  semanticSearch,
} from '../../src/services/search-service.js';
import { closeAll, getDb } from '../../src/storage/db.js';
import { appendEvent } from '../../src/storage/event-store.js';

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-semantic-'));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  delete process.env.MEMORIZE_EMBEDDINGS_ENDPOINT;
  delete process.env.MEMORIZE_EMBEDDINGS_API_KEY;
  delete process.env.MEMORIZE_EMBEDDINGS_MODEL;
  await rm(sandbox, { recursive: true, force: true });
});

/** Deterministic embedder: exact-text → canned vector (zero vector if unknown). */
function fakeEmbedder(
  vectors: Record<string, number[]>,
  model = 'fake-embed-v1',
): Embedder & { calls: string[][] } {
  const dim = Object.values(vectors)[0]?.length ?? 3;
  const calls: string[][] = [];
  return {
    model,
    calls,
    async embed(texts: string[]): Promise<number[][]> {
      calls.push(texts);
      return texts.map((t) => vectors[t] ?? new Array(dim).fill(0));
    },
  };
}

async function seedMemory(
  projectId: string,
  text: string,
  kind: ConsolidatedMemoryKind = 'decision',
): Promise<string> {
  const memory = createConsolidatedMemory({
    projectId,
    kind,
    text,
    salience: 7,
    sourceObservationIds: [],
  });
  await appendEvent({
    type: 'memory.consolidated',
    projectId,
    scopeType: 'session',
    scopeId: projectId,
    actor: 'test',
    payload: memory,
  });
  return memory.id;
}

// Concept space: axis 0 = database, 1 = frontend, 2 = misc.
const MEM_A = 'Chose PostgreSQL for the primary datastore';
const MEM_B = 'The relational engine selection is final';
const MEM_C = 'Frontend uses React hooks everywhere';
const VECTORS: Record<string, number[]> = {
  [MEM_A]: [0.9, 0, 0.1],
  [MEM_B]: [1, 0, 0],
  [MEM_C]: [0, 1, 0],
  postgresql: [1, 0, 0], // query — closest to MEM_B, no shared word with B
};

describe('semantic search (P3-c)', () => {
  it('creates the embeddings table at user_version >= 8', async () => {
    const project = await createProject({ title: 'S', rootPath: join(sandbox, 'p') });
    await rebuildProjectProjection(project.id);
    const db = getDb(project.id);
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(8);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE name = 'embeddings'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('embeddings');
  });

  it('ensureEmbeddings embeds valid memories and skips unchanged ones', async () => {
    const project = await createProject({ title: 'S', rootPath: join(sandbox, 'p') });
    const idA = await seedMemory(project.id, MEM_A);
    await seedMemory(project.id, MEM_B);
    await rebuildProjectProjection(project.id);

    const embedder = fakeEmbedder(VECTORS);
    const first = await ensureEmbeddings(project.id, { embedder });
    expect(first.embedded).toBe(2);
    expect(listEmbeddings(project.id, 'memory')).toHaveLength(2);
    expect(getEmbedding(project.id, idA)?.vector).toEqual(VECTORS[MEM_A]);

    // Second call: nothing changed → no re-embedding (text_hash + model match).
    const second = await ensureEmbeddings(project.id, { embedder });
    expect(second.embedded).toBe(0);
  });

  it('ranks memories by cosine similarity to the query', async () => {
    const project = await createProject({ title: 'S', rootPath: join(sandbox, 'p') });
    const idA = await seedMemory(project.id, MEM_A);
    const idB = await seedMemory(project.id, MEM_B);
    await seedMemory(project.id, MEM_C);
    await rebuildProjectProjection(project.id);

    const embedder = fakeEmbedder(VECTORS);
    await ensureEmbeddings(project.id, { embedder });

    const hits = await semanticSearch(project.id, 'postgresql', 10, embedder);
    // MEM_B (cos 1.0) and MEM_A (cos ~0.994) lead; MEM_C (cos 0) trails.
    expect(hits[0]!.entityId).toBe(idB);
    expect(hits[1]!.entityId).toBe(idA);
    expect(hits[0]!.kind).toBe('memory');
    expect(hits[0]!.snippet).toContain('relational');
  });

  it('hybridSearch fuses FTS and semantic — surfaces a semantic-only memory', async () => {
    const project = await createProject({ title: 'S', rootPath: join(sandbox, 'p') });
    const idA = await seedMemory(project.id, MEM_A); // contains "PostgreSQL" → FTS hit
    const idB = await seedMemory(project.id, MEM_B); // no query word → semantic-only
    await seedMemory(project.id, MEM_C);
    await rebuildProjectProjection(project.id);

    const embedder = fakeEmbedder(VECTORS);
    await ensureEmbeddings(project.id, { embedder });

    // Pure FTS finds only MEM_A for "postgresql".
    const lexical = searchProject(project.id, 'postgresql');
    expect(lexical.map((h) => h.entityId)).toEqual([idA]);

    // Hybrid surfaces MEM_B too (semantic), fused best-first.
    const hits = await hybridSearch(project.id, 'postgresql', 10, embedder);
    const ids = hits.map((h) => h.entityId);
    expect(ids).toContain(idA);
    expect(ids).toContain(idB);
    // The semantic-only hit carries a snippet from the memory text.
    const bHit = hits.find((h) => h.entityId === idB)!;
    expect(bHit.snippet).toContain('relational');
  });

  it('degrades gracefully to FTS when embeddings are unconfigured', async () => {
    const project = await createProject({ title: 'S', rootPath: join(sandbox, 'p') });
    const idA = await seedMemory(project.id, MEM_A);
    await seedMemory(project.id, MEM_B);
    await rebuildProjectProjection(project.id);

    // No embedder configured, no embeddings stored.
    expect((await ensureEmbeddings(project.id)).embedded).toBe(0);
    expect(await semanticSearch(project.id, 'postgresql')).toEqual([]);

    const hybrid = await hybridSearch(project.id, 'postgresql');
    const lexical = searchProject(project.id, 'postgresql');
    expect(hybrid.map((h) => h.entityId)).toEqual(
      lexical.map((h) => h.entityId),
    );
    expect(hybrid.map((h) => h.entityId)).toEqual([idA]);
  });

  it('ensureEmbeddings never throws when the embedder fails', async () => {
    const project = await createProject({ title: 'S', rootPath: join(sandbox, 'p') });
    await seedMemory(project.id, MEM_A);
    await rebuildProjectProjection(project.id);

    const throwingEmbedder: Embedder = {
      model: 'boom',
      embed: () => Promise.reject(new Error('network down')),
    };
    const result = await ensureEmbeddings(project.id, {
      embedder: throwingEmbedder,
    });
    expect(result.embedded).toBe(0);
    expect(listEmbeddings(project.id, 'memory')).toHaveLength(0);
  });
});

describe('embeddings math + config (unit)', () => {
  it('cosineSimilarity: identical=1, orthogonal=0, mismatched-length=0', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 6); // same direction
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0); // length mismatch
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('reciprocalRankFusion: rewards items ranked high in multiple lists', () => {
    const fused = reciprocalRankFusion([
      ['a', 'b', 'c'],
      ['b', 'a', 'd'],
    ]);
    // 'a': 1/61 + 1/62, 'b': 1/61 + 1/62 — tie at top; both beat c and d.
    const ranked = [...fused.entries()].sort((x, y) => y[1] - x[1]).map((e) => e[0]);
    expect(ranked.slice(0, 2).sort()).toEqual(['a', 'b']);
    expect(fused.get('a')!).toBeGreaterThan(fused.get('c')!);
  });

  it('resolveEmbeddingsConfig: enabled by endpoint OR key, else off', () => {
    expect(resolveEmbeddingsConfig({})).toBeUndefined();
    expect(
      resolveEmbeddingsConfig({ MEMORIZE_EMBEDDINGS_API_KEY: 'k' }),
    ).toMatchObject({ apiKey: 'k' });
    // Keyless local server: endpoint alone enables it (no apiKey field).
    const local = resolveEmbeddingsConfig({
      MEMORIZE_EMBEDDINGS_ENDPOINT: 'http://localhost:11434/v1',
    });
    expect(local?.endpoint).toBe('http://localhost:11434/v1');
    expect(local?.apiKey).toBeUndefined();
  });
});
