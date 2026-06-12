import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../src/domain/common.js';
import {
  getMemoryIndex,
  listImportedRules,
  rebuildProjectProjection,
} from '../../src/services/projection-store.js';
import { closeAll } from '../../src/storage/db.js';
import { appendEvent } from '../../src/storage/event-store.js';

const projectId = 'proj_dedup_test1';
const ts = '2026-01-01T00:00:00.000Z';
const tsNewer = '2026-01-02T00:00:00.000Z';

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-dedup-'));
  process.env.MEMORIZE_ROOT = join(sandbox, 'root');
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

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
      createdAt: ts,
      updatedAt: ts,
      title: 'Dedup Test',
      summary: 'imported-rule dedup test project',
      goals: [],
      status: 'active',
      rootPath: '/tmp/dedup',
      activeWorkstreamIds: [],
      activeTaskIds: [],
      acceptedDecisionIds: [],
      ruleIds: [],
    } as never,
  });
}

describe('projection-imported-dedup', () => {
  it('mustReadTopics exposes only the newest rule when duplicates exist', async () => {
    await seedProject();

    // Simulate pre-idempotent-import re-runs: two rule.upserted events with
    // the same title but different ids and increasing updatedAt.
    await appendEvent({
      type: 'rule.upserted',
      projectId,
      scopeType: 'project',
      scopeId: projectId,
      actor: 'system-import',
      payload: {
        id: 'rule_dup_old',
        schemaVersion: CURRENT_SCHEMA_VERSION,
        createdAt: ts,
        updatedAt: ts,
        scopeType: 'project',
        scopeId: projectId,
        title: 'Imported CLAUDE.md',
        body: 'old body',
        priority: 100,
        source: 'imported',
        updatedBy: 'system-import',
      } as never,
    });

    await appendEvent({
      type: 'rule.upserted',
      projectId,
      scopeType: 'project',
      scopeId: projectId,
      actor: 'system-import',
      payload: {
        id: 'rule_dup_new',
        schemaVersion: CURRENT_SCHEMA_VERSION,
        createdAt: tsNewer,
        updatedAt: tsNewer,
        scopeType: 'project',
        scopeId: projectId,
        title: 'Imported CLAUDE.md',
        body: 'new body',
        priority: 100,
        source: 'imported',
        updatedBy: 'system-import',
      } as never,
    });

    await rebuildProjectProjection(projectId);

    // 1. mustReadTopics has exactly ONE entry and it points to the newer rule
    const index = getMemoryIndex(projectId);
    expect(index).toBeDefined();
    const topics = index!.mustReadTopics ?? [];
    const claudeTopics = topics.filter((t) => t.title === 'Imported CLAUDE.md');
    expect(claudeTopics).toHaveLength(1);
    expect(claudeTopics[0]!.id).toBe('rule_dup_new');

    // 2. listImportedRules returns BOTH rules (event-log data preserved)
    const allImported = listImportedRules(projectId);
    expect(allImported).toHaveLength(2);
    const ids = allImported.map((r) => r.id).sort();
    expect(ids).toEqual(['rule_dup_new', 'rule_dup_old']);
  });

  it('a second distinct title still appears — dedup is per-title', async () => {
    await seedProject();

    // One duplicate pair for CLAUDE.md
    await appendEvent({
      type: 'rule.upserted',
      projectId,
      scopeType: 'project',
      scopeId: projectId,
      actor: 'system-import',
      payload: {
        id: 'rule_dup_old',
        schemaVersion: CURRENT_SCHEMA_VERSION,
        createdAt: ts,
        updatedAt: ts,
        scopeType: 'project',
        scopeId: projectId,
        title: 'Imported CLAUDE.md',
        body: 'old body',
        priority: 100,
        source: 'imported',
        updatedBy: 'system-import',
      } as never,
    });
    await appendEvent({
      type: 'rule.upserted',
      projectId,
      scopeType: 'project',
      scopeId: projectId,
      actor: 'system-import',
      payload: {
        id: 'rule_dup_new',
        schemaVersion: CURRENT_SCHEMA_VERSION,
        createdAt: tsNewer,
        updatedAt: tsNewer,
        scopeType: 'project',
        scopeId: projectId,
        title: 'Imported CLAUDE.md',
        body: 'new body',
        priority: 100,
        source: 'imported',
        updatedBy: 'system-import',
      } as never,
    });

    // One non-duplicate rule for AGENTS.md
    await appendEvent({
      type: 'rule.upserted',
      projectId,
      scopeType: 'project',
      scopeId: projectId,
      actor: 'system-import',
      payload: {
        id: 'rule_agents',
        schemaVersion: CURRENT_SCHEMA_VERSION,
        createdAt: ts,
        updatedAt: ts,
        scopeType: 'project',
        scopeId: projectId,
        title: 'Imported AGENTS.md',
        body: 'agent rules',
        priority: 100,
        source: 'imported',
        updatedBy: 'system-import',
      } as never,
    });

    await rebuildProjectProjection(projectId);

    const index = getMemoryIndex(projectId);
    const topics = index!.mustReadTopics ?? [];
    // Two distinct titles → two topics
    expect(topics).toHaveLength(2);
    const titles = topics.map((t) => t.title).sort();
    expect(titles).toEqual(['Imported AGENTS.md', 'Imported CLAUDE.md']);
    // The CLAUDE.md topic must still point to the newer rule
    const claudeTopic = topics.find((t) => t.title === 'Imported CLAUDE.md');
    expect(claudeTopic!.id).toBe('rule_dup_new');
  });
});
