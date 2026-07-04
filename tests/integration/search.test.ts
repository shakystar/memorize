import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../src/domain/common.js';
import type { DomainEvent } from '../../src/domain/events.js';
import { migrateProjectFromNdjson } from '../../src/services/migrate-service.js';
import { rebuildProjectProjection } from '../../src/services/projection-store.js';
import {
  searchProject,
  toFtsMatch,
} from '../../src/services/search-service.js';
import {
  createHandoff,
  createTask,
  updateTask,
} from '../../src/services/task-service.js';
import { closeAll, getDb } from '../../src/storage/db.js';
import { appendEvent } from '../../src/storage/event-store.js';

const projectId = 'proj_search_test1';
const ts = '2026-02-02T00:00:00.000Z';

let sandbox: string;

function evt(
  overrides: Partial<DomainEvent> & Pick<DomainEvent, 'id' | 'type'>,
): DomainEvent {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: ts,
    updatedAt: ts,
    projectId,
    scopeType: 'project',
    scopeId: projectId,
    actor: 'test',
    payload: {},
    ...overrides,
  } as DomainEvent;
}

const projectCreated = evt({
  id: 'evt_p',
  type: 'project.created',
  payload: {
    id: projectId,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: ts,
    updatedAt: ts,
    title: 'Search',
    summary: 'search project',
    goals: [],
    status: 'active',
    rootPath: '/tmp/search',
    activeWorkstreamIds: [],
    activeTaskIds: [],
    acceptedDecisionIds: [],
    ruleIds: [],
  } as never,
});

async function seedProject(): Promise<void> {
  await appendEvent({
    type: projectCreated.type,
    projectId,
    scopeType: projectCreated.scopeType,
    scopeId: projectCreated.scopeId,
    actor: projectCreated.actor,
    payload: projectCreated.payload as never,
  });
  await rebuildProjectProjection(projectId);
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-search-'));
  process.env.MEMORIZE_ROOT = sandbox;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('search (FTS5)', () => {
  it('creates the search_fts virtual table at user_version >= 4', async () => {
    await seedProject();
    const db = getDb(projectId);
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(
      4,
    );
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name = 'search_fts'",
      )
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('search_fts');
  });

  it('returns a created task ranked for a known word', async () => {
    await seedProject();
    const task = await createTask({
      projectId,
      title: 'Implement quokka migration pipeline',
      description: 'A distinctive marsupial keyword: quokka',
      actor: 'test',
    });

    const hits = searchProject(projectId, 'quokka');
    expect(hits.length).toBeGreaterThan(0);
    const top = hits[0]!;
    expect(top.entityId).toBe(task.id);
    expect(top.kind).toBe('task');
    expect(top.snippet).toContain('[quokka]');
    expect(typeof top.score).toBe('number');
  });

  it('finds a handoff by its summary text', async () => {
    await seedProject();
    const task = await createTask({
      projectId,
      title: 'Carrier task',
      actor: 'test',
    });
    await updateTask(projectId, task.id, { status: 'in_progress' }, 'test');
    const handoff = await createHandoff({
      projectId,
      taskId: task.id,
      fromActor: 'a',
      toActor: 'b',
      summary: 'Investigated the platypus deadlock thoroughly',
      nextAction: 'continue',
    });

    const hits = searchProject(projectId, 'platypus');
    expect(hits.some((h) => h.entityId === handoff.id && h.kind === 'handoff')).toBe(
      true,
    );
  });

  it('returns nothing for an absent term', async () => {
    await seedProject();
    await createTask({
      projectId,
      title: 'ordinary work',
      actor: 'test',
    });
    expect(searchProject(projectId, 'zzzznonexistentterm')).toEqual([]);
  });

  it('migrate populates the index (search works without an explicit rebuild)', async () => {
    const taskEvent = evt({
      id: 'evt_t1',
      type: 'task.created',
      scopeType: 'task',
      scopeId: 'task_mig1',
      payload: {
        id: 'task_mig1',
        schemaVersion: CURRENT_SCHEMA_VERSION,
        createdAt: ts,
        updatedAt: ts,
        projectId,
        title: 'Migrated narwhal task',
        description: 'narwhal in the index',
        status: 'todo',
        priority: 'high',
        ownerType: 'unassigned',
        goal: 'narwhal',
        acceptanceCriteria: [],
        dependsOn: [],
        contextRefIds: [],
        decisionRefIds: [],
        ruleRefIds: [],
        openQuestions: [],
        riskNotes: [],
      } as never,
    });
    const eventsDir = join(sandbox, 'accounts', 'local_default', 'projects', projectId, 'events');
    await mkdir(eventsDir, { recursive: true });
    await writeFile(
      join(eventsDir, '2026-02-02.ndjson'),
      [projectCreated, taskEvent].map((e) => JSON.stringify(e)).join('\n') +
        '\n',
      'utf8',
    );

    const result = await migrateProjectFromNdjson(projectId);
    expect(result.status).toBe('migrated');

    const hits = searchProject(projectId, 'narwhal');
    expect(hits.some((h) => h.entityId === 'task_mig1')).toBe(true);
  });

  it('does not crash on punctuation-only or empty queries', async () => {
    await seedProject();
    await createTask({ projectId, title: 'something', actor: 'test' });

    expect(searchProject(projectId, '')).toEqual([]);
    expect(searchProject(projectId, '   ')).toEqual([]);
    expect(searchProject(projectId, '!!! ??? ***')).toEqual([]);
    // Punctuation mixed with a real token must not throw and should match.
    expect(() => searchProject(projectId, 'some-thing! (else)')).not.toThrow();
  });

  it('toFtsMatch OR-joins tokens and rejects content-free queries', () => {
    expect(toFtsMatch('hello world')).toBe('"hello" OR "world"');
    // Embedded double-quotes are doubled (FTS5 string escaping).
    expect(toFtsMatch('say "hi"')).toBe('"say" OR """hi"""');
    expect(toFtsMatch('   ')).toBeUndefined();
    expect(toFtsMatch('!!!')).toBeUndefined();
  });

  it('matches a document that contains only SOME of a multi-word query (OR, not AND)', async () => {
    await seedProject();
    const task = await createTask({
      projectId,
      title: 'Quokka habitat notes',
      description: 'A distinctive marsupial keyword: quokka',
      actor: 'test',
    });
    // The query has words that do NOT all appear in the task; under the old
    // AND-join this returned nothing. OR-join must still surface the task.
    const hits = searchProject(projectId, 'where does the quokka sleep at night');
    expect(hits.some((h) => h.entityId === task.id)).toBe(true);
  });
});

describe('search (CLI smoke)', () => {
  const repoRoot = process.cwd();
  const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

  let cliSandbox: string;
  let cliRoot: string;

  function runCli(args: string[]): ReturnType<typeof spawnSync> {
    return spawnSync('node', [tsxCliPath, cliEntryPath, ...args], {
      cwd: cliSandbox,
      encoding: 'utf8',
      env: { ...process.env, MEMORIZE_ROOT: cliRoot },
    });
  }

  beforeEach(async () => {
    cliSandbox = await realpath(await mkdtemp(join(tmpdir(), 'memorize-search-cli-')));
    cliRoot = join(cliSandbox, '.memorize-home');
  });

  afterEach(async () => {
    await rm(cliSandbox, { recursive: true, force: true });
  });

  it('memorize search returns a created task (human + --json)', { timeout: 30_000 }, () => {
    expect(runCli(['project', 'init']).status).toBe(0);
    expect(runCli(['task', 'create', 'distinctivewombat', 'pipeline']).status).toBe(
      0,
    );

    const human = runCli(['search', 'distinctivewombat']);
    expect(human.status).toBe(0);
    expect(human.stdout).toContain('task');
    expect(human.stdout).toContain('distinctivewombat');

    const json = runCli(['search', 'distinctivewombat', '--json']);
    expect(json.status).toBe(0);
    const parsed = JSON.parse(json.stdout as string) as Array<{
      kind: string;
      entityId: string;
    }>;
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0]!.kind).toBe('task');

    // Absent term: clean exit, friendly message.
    const none = runCli(['search', 'zzzznope']);
    expect(none.status).toBe(0);
    expect(none.stdout).toContain('No matches found.');
  });

  it('accepts --union and leaves self-hit output untagged', { timeout: 30_000 }, () => {
    expect(runCli(['project', 'init']).status).toBe(0);
    expect(runCli(['task', 'create', 'distinctivewombat', 'pipeline']).status).toBe(0);

    const union = runCli(['search', 'distinctivewombat', '--union']);
    expect(union.status).toBe(0);
    // Only self rows exist here, so union output is identical to default —
    // no bracket provenance tag.
    expect(union.stdout).toContain('task\t');
    expect(union.stdout).not.toContain('[proj_');
  });
});
