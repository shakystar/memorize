import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { chunkConversation } from '../../src/services/transcript-reader.js';
import {
  insertSegments,
  listSegments,
  listSegmentTexts,
  pruneSegments,
  type SegmentRow,
} from '../../src/services/segment-store.js';
import { getEmbedding, upsertEmbedding } from '../../src/services/embeddings-store.js';
import { rebuildProjectProjection } from '../../src/services/projection-store.js';
import { hybridSearchSegments, searchByKind } from '../../src/services/search-service.js';
import { retrieveSegments } from '../../src/services/memory-retrieval-service.js';
import { closeAll } from '../../src/storage/db.js';
import { appendEvent } from '../../src/storage/event-store.js';
import { CURRENT_SCHEMA_VERSION } from '../../src/domain/common.js';

const projectId = 'proj_seg_test';
let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-seg-'));
  process.env.MEMORIZE_ROOT = sandbox;
});
afterEach(async () => {
  closeAll();
  await rm(sandbox, { recursive: true, force: true });
  delete process.env.MEMORIZE_ROOT;
});

function seg(id: string, text: string, createdAt: string): SegmentRow {
  return { id, sessionId: 's1', createdAt, ordinal: 0, text };
}

async function seedProject(): Promise<void> {
  await appendEvent({
    type: 'project.created',
    projectId,
    scopeType: 'project',
    scopeId: projectId,
    actor: 'test',
    payload: {
      id: projectId,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      title: 'seg',
      summary: 'segment test project',
      goals: [],
      status: 'active',
      rootPath: '/tmp/seg',
      activeWorkstreamIds: [],
      activeTaskIds: [],
      acceptedDecisionIds: [],
      ruleIds: [],
    } as never,
  });
}

describe('chunkConversation', () => {
  it('packs whole turns up to the budget', () => {
    const text = ['USER: aaaaaaaa', 'AGENT: bbbbbbbb', 'USER: cccccccc'].join('\n\n');
    const chunks = chunkConversation(text, 24);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // No chunk splits a turn: every turn appears intact somewhere.
    expect(chunks.join('\n\n')).toContain('USER: aaaaaaaa');
    expect(chunks.join('\n\n')).toContain('USER: cccccccc');
  });
  it('keeps an over-budget turn as its own chunk', () => {
    const big = `USER: ${'x'.repeat(100)}`;
    const chunks = chunkConversation([big, 'AGENT: ok'].join('\n\n'), 30);
    expect(chunks.some((c) => c.includes('x'.repeat(100)))).toBe(true);
  });
  it('returns [] for empty/blank input', () => {
    expect(chunkConversation('')).toEqual([]);
    expect(chunkConversation('   \n\n   ')).toEqual([]);
  });
});

describe('segment-store', () => {
  it('inserts and lists newest-first; hydrates text by id', () => {
    insertSegments(projectId, [
      seg('seg_1', 'alpha', '2026-01-01T00:00:00.000Z'),
      seg('seg_2', 'beta', '2026-02-01T00:00:00.000Z'),
    ]);
    expect(listSegments(projectId).map((r) => r.id)).toEqual(['seg_2', 'seg_1']);
    expect(listSegmentTexts(projectId).get('seg_1')).toBe('alpha');
  });

  it('prunes by age and co-deletes the segment embedding', () => {
    insertSegments(projectId, [seg('seg_old', 'old', '2020-01-01T00:00:00.000Z')]);
    upsertEmbedding(projectId, {
      entityId: 'seg_old',
      kind: 'segment',
      model: 'm',
      dim: 1,
      vector: [1],
      textHash: 'h',
      createdAt: '2020-01-01T00:00:00.000Z',
    });
    const deleted = pruneSegments(projectId, {
      maxAgeDays: 30,
      nowMs: Date.parse('2026-01-01T00:00:00.000Z'),
    });
    expect(deleted).toContain('seg_old');
    expect(listSegments(projectId)).toHaveLength(0);
    expect(getEmbedding(projectId, 'seg_old')).toBeUndefined();
  });

  it('prunes oldest beyond the count cap', () => {
    insertSegments(
      projectId,
      Array.from({ length: 5 }, (_, i) => seg(`seg_${i}`, `t${i}`, `2026-01-0${i + 1}T00:00:00.000Z`)),
    );
    const deleted = pruneSegments(projectId, {
      maxCount: 2,
      maxAgeDays: 3650,
      nowMs: Date.parse('2026-02-01T00:00:00.000Z'),
    });
    expect(deleted).toHaveLength(3);
    expect(listSegments(projectId)).toHaveLength(2);
  });
});

describe('segment search + retrieval', () => {
  beforeEach(seedProject);

  it('reindex emits kind=segment FTS rows; searchByKind/hybrid find them', async () => {
    insertSegments(projectId, [
      seg('seg_a', 'the navy blazer dry cleaning pickup', '2026-01-01T00:00:00.000Z'),
    ]);
    await rebuildProjectProjection(projectId, { reindexSearch: true });

    const hits = searchByKind(projectId, 'blazer dry cleaning', 'segment');
    expect(hits.map((h) => h.entityId)).toContain('seg_a');

    const hybrid = await hybridSearchSegments(projectId, 'blazer dry cleaning');
    expect(hybrid.length).toBeGreaterThan(0);
    expect(hybrid.map((h) => h.entityId)).toContain('seg_a');
    expect(hybrid[0]!.snippet.length).toBeGreaterThan(0);
  });

  it('reindex with no segments is a no-op (no kind=segment rows)', async () => {
    await rebuildProjectProjection(projectId, { reindexSearch: true });
    expect(searchByKind(projectId, 'anything', 'segment')).toHaveLength(0);
  });

  it('retrieveSegments returns full text within budget; empty without a task', async () => {
    insertSegments(projectId, [
      seg('seg_b', 'alpha beta gamma project timeline planning', '2026-01-01T00:00:00.000Z'),
    ]);
    await rebuildProjectProjection(projectId, { reindexSearch: true });

    expect(await retrieveSegments(projectId, {})).toEqual([]);
    const got = await retrieveSegments(projectId, { taskTitle: 'project timeline' });
    expect(got.map((s) => s.id)).toContain('seg_b');
    expect(got.find((s) => s.id === 'seg_b')!.text).toContain('project timeline');
  });

  it('retrieveSegments respects its char budget', async () => {
    insertSegments(projectId, [
      seg('seg_x', `${'budgetword '.repeat(40)}`, '2026-01-02T00:00:00.000Z'),
      seg('seg_y', `${'budgetword '.repeat(40)}`, '2026-01-01T00:00:00.000Z'),
    ]);
    await rebuildProjectProjection(projectId, { reindexSearch: true });
    const got = await retrieveSegments(projectId, { taskTitle: 'budgetword', budgetChars: 500 });
    const totalChars = got.reduce((n, s) => n + s.text.length, 0);
    expect(totalChars).toBeLessThanOrEqual(500);
  });
});
