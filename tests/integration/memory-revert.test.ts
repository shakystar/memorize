import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../../src/domain/common.js';
import { createConsolidatedMemory } from '../../src/domain/entities.js';
import { revertSession } from '../../src/services/project-service.js';
import {
  getMemory,
  listValidMemories,
  rebuildProjectProjection,
} from '../../src/services/projection-store.js';
import { closeAll } from '../../src/storage/db.js';
import { appendEvent } from '../../src/storage/event-store.js';

const projectId = 'proj_revert_test1';
const ts = '2026-07-01T00:00:00.000Z';

let sandbox: string;

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
      title: 'Revert',
      summary: 'memory revert test project',
      goals: [],
      status: 'active',
      rootPath: '/tmp/revert',
      activeWorkstreamIds: [],
      activeTaskIds: [],
      acceptedDecisionIds: [],
      ruleIds: [],
    } as never,
  });
  await rebuildProjectProjection(projectId);
}

async function addMemory(
  text: string,
  sessionId?: string,
  sourceProjectId?: string,
): Promise<string> {
  const mem = createConsolidatedMemory({
    projectId,
    kind: 'decision',
    text,
    salience: 7,
    ...(sessionId ? { sessionId } : {}),
  });
  await appendEvent({
    type: 'memory.consolidated',
    projectId,
    scopeType: 'session',
    scopeId: sessionId ?? projectId,
    actor: 'test',
    ...(sourceProjectId ? { sourceProjectId } : {}),
    payload: mem,
  });
  return mem.id;
}

const validIds = (): string[] =>
  listValidMemories(projectId).map((r) => r.memory.id);

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-revert-'));
  process.env.MEMORIZE_ROOT = sandbox;
  delete process.env.MEMORIZE_LLM_API_KEY;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('revertSession (M3-c, SoT-050 consolidated revert)', () => {
  it('reverts only the target session’s memories, leaving others', async () => {
    await seedProject();
    const a1 = await addMemory('session A one', 'sess_A');
    const a2 = await addMemory('session A two', 'sess_A');
    const b1 = await addMemory('session B one', 'sess_B');
    await rebuildProjectProjection(projectId);
    expect(validIds().sort()).toEqual([a1, a2, b1].sort());

    const result = await revertSession({ projectId, sessionId: 'sess_A' });
    expect(result.reverted.sort()).toEqual([a1, a2].sort());
    expect(result.dryRun).toBe(false);

    // Session A gone from valid reads; session B untouched.
    expect(validIds()).toEqual([b1]);
    // Rows preserved + flagged retracted (reversible / auditable).
    expect(getMemory(projectId, a1)?.memory.retractedAt).toBeTruthy();
    expect(getMemory(projectId, b1)?.memory.retractedAt).toBeUndefined();
  });

  it('--dry-run lists targets without mutating', async () => {
    await seedProject();
    const a1 = await addMemory('dry A', 'sess_A');
    await rebuildProjectProjection(projectId);

    const result = await revertSession({
      projectId,
      sessionId: 'sess_A',
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.reverted).toEqual([a1]);
    // Untouched.
    expect(validIds()).toEqual([a1]);
    expect(getMemory(projectId, a1)?.memory.retractedAt).toBeUndefined();
  });

  it('is idempotent and a no-op for a session with no valid memories', async () => {
    await seedProject();
    await addMemory('once', 'sess_A');
    await rebuildProjectProjection(projectId);

    const first = await revertSession({ projectId, sessionId: 'sess_A' });
    expect(first.reverted).toHaveLength(1);
    const second = await revertSession({ projectId, sessionId: 'sess_A' });
    expect(second.reverted).toEqual([]); // already retracted
    const unknown = await revertSession({ projectId, sessionId: 'sess_ghost' });
    expect(unknown.reverted).toEqual([]);
  });

  it('never reverts a foreign-lane (workspace union) memory', async () => {
    await seedProject();
    const self = await addMemory('self session A', 'sess_A');
    const foreign = await addMemory('foreign same session', 'sess_A', 'proj_other');
    await rebuildProjectProjection(projectId);

    const result = await revertSession({ projectId, sessionId: 'sess_A' });
    // Only the self-lane memory is reverted.
    expect(result.reverted).toEqual([self]);
    // The foreign-lane memory is untouched (owner-global retract is W3).
    expect(getMemory(projectId, foreign)?.memory.retractedAt).toBeUndefined();
  });
});

describe('memorize memory revert (CLI)', () => {
  const repoRoot = process.cwd();
  const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');
  let memorizeRoot: string;

  function runCli(args: string[], input?: string) {
    return spawnSync(process.execPath, [tsxCliPath, cliEntryPath, ...args], {
      cwd: sandbox,
      encoding: 'utf8',
      env: { ...process.env, MEMORIZE_ROOT: memorizeRoot },
      ...(input !== undefined ? { input } : {}),
    });
  }

  it('reverts a session’s imported memory (dry-run first, then real)', () => {
    memorizeRoot = join(sandbox, '.memorize-home');
    expect(
      runCli(
        ['hook', 'claude', 'SessionStart'],
        JSON.stringify({
          cwd: sandbox,
          hook_event_name: 'SessionStart',
          session_id: 'revert-cli-1',
        }),
      ).status,
    ).toBe(0);

    // Import a memory tagged with a session id.
    expect(
      runCli(
        ['memory', 'import', '--source', 'claude-memory', '--session', 'sess_cli'],
        JSON.stringify([
          { kind: 'decision', text: 'Revert via CLI: adopt marimba indexing', salience: 8 },
        ]),
      ).status,
    ).toBe(0);
    const id = (JSON.parse(runCli(['memory', 'list', '--json']).stdout) as Array<{
      memory: { id: string };
    }>)[0]!.memory.id;

    // Dry run reports it but leaves it.
    const dry = JSON.parse(
      runCli(['memory', 'revert', '--session', 'sess_cli', '--dry-run', '--json']).stdout,
    ) as { reverted: string[]; dryRun: boolean };
    expect(dry.dryRun).toBe(true);
    expect(dry.reverted).toContain(id);
    expect(
      (JSON.parse(runCli(['memory', 'list', '--json']).stdout) as unknown[]).length,
    ).toBe(1);

    // Real revert removes it from the valid list.
    const real = JSON.parse(
      runCli(['memory', 'revert', '--session', 'sess_cli', '--json']).stdout,
    ) as { reverted: string[] };
    expect(real.reverted).toContain(id);
    expect(
      (JSON.parse(runCli(['memory', 'list', '--json']).stdout) as unknown[]).length,
    ).toBe(0);
  });

  it('fails with usage when --session is missing', () => {
    memorizeRoot = join(sandbox, '.memorize-home2');
    runCli(
      ['hook', 'claude', 'SessionStart'],
      JSON.stringify({
        cwd: sandbox,
        hook_event_name: 'SessionStart',
        session_id: 'revert-cli-2',
      }),
    );
    const res = runCli(['memory', 'revert']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/session/i);
  });
});
