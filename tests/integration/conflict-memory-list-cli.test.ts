import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setupProject } from '../../src/services/setup-service.js';
import { getBoundProjectId } from '../../src/services/project-service.js';
import { importMemories } from '../../src/services/memory-import-service.js';
import { rebuildProjectProjection } from '../../src/services/projection-store.js';
import { closeAll } from '../../src/storage/db.js';

let sandbox: string;
let memorizeRoot: string;

const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

function runCli(args: string[], input?: string) {
  return spawnSync(process.execPath, [tsxCliPath, cliEntryPath, ...args], {
    cwd: sandbox,
    encoding: 'utf8',
    env: { ...process.env, MEMORIZE_ROOT: memorizeRoot },
    ...(input !== undefined ? { input } : {}),
  });
}

beforeEach(async () => {
  // macOS os.tmpdir() is a symlink (/var -> /private/var); canonicalize so the
  // path we bind in-process matches the realpath the spawned CLI sees as cwd.
  sandbox = await realpath(await mkdtemp(join(tmpdir(), 'memorize-conflict-memlist-')));
  memorizeRoot = join(sandbox, '.memorize-home');
  process.env.MEMORIZE_ROOT = memorizeRoot;
  delete process.env.MEMORIZE_LLM_API_KEY;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('memorize conflict (unknown-subcommand rejection)', () => {
  async function bindWithConflict(): Promise<string> {
    await mkdir(join(sandbox, '.cursor', 'rules'), { recursive: true });
    await writeFile(
      join(sandbox, 'AGENTS.md'),
      '# Project guidance\nKeep commits small.\n',
      'utf8',
    );
    await writeFile(
      join(sandbox, 'CLAUDE.md'),
      '# Claude guidance\nSquash changes into one final commit.\n',
      'utf8',
    );
    await setupProject(sandbox);
    const projectId = await getBoundProjectId(sandbox);
    if (!projectId) throw new Error('Expected project id after setup.');
    await rebuildProjectProjection(projectId);
    return projectId;
  }

  it('rejects an unknown subcommand (typo) instead of silently listing', async () => {
    await bindWithConflict();
    const result = runCli(['conflict', 'resovle']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Unknown conflict subcommand/i);
  });

  it('`conflict list` prints the open conflicts (no throw)', async () => {
    await bindWithConflict();
    const result = runCli(['conflict', 'list']);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('bare `conflict` still prints the open conflicts', async () => {
    await bindWithConflict();
    const result = runCli(['conflict']);
    expect(result.status).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  it('`conflict resolve` still routes to the resolve path (not unknown-subcommand)', async () => {
    await bindWithConflict();
    // `resolve` with a missing id hits the resolve handler's usage guard, NOT
    // the new unknown-subcommand rejection — proving the dispatch still routes
    // `resolve` correctly after the catch-all was tightened. (End-to-end
    // resolution of a seeded conflict exercises a pre-existing conflict
    // projection-rebuild path outside this slice's scope.)
    const result = runCli(['conflict', 'resolve']);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toMatch(/Unknown conflict subcommand/i);
    expect(result.stderr).toMatch(/conflict resolve <id>/i);
  });
});

describe('memorize memory list (whole-store observation)', () => {
  async function bindAndImportTwo(): Promise<void> {
    const start = runCli(
      ['hook', 'claude', 'SessionStart'],
      JSON.stringify({
        cwd: sandbox,
        hook_event_name: 'SessionStart',
        session_id: 'memlist-uuid-1',
      }),
    );
    expect(start.status).toBe(0);
    const projectId = await getBoundProjectId(sandbox);
    if (!projectId) throw new Error('Expected project id after SessionStart.');
    await importMemories({
      projectId,
      actor: 'claude',
      source: 'claude-memory',
      itemsJson: JSON.stringify([
        { kind: 'decision', text: 'Adopt SQLite + FTS5 for the index', salience: 8 },
        { kind: 'rationale', text: 'Event log is the single source of truth', salience: 5 },
      ]),
    });
  }

  it('lists all valid memories (human, tab-separated)', async () => {
    await bindAndImportTwo();
    const result = runCli(['memory', 'list']);
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
    expect(result.stdout).toContain('SQLite');
    expect(result.stdout).toContain('source of truth');
    // tab-separated columns.
    expect(lines[0]).toContain('\t');
  });

  it('--json yields a valid JSON array of rows', async () => {
    await bindAndImportTwo();
    const result = runCli(['memory', 'list', '--json']);
    expect(result.status).toBe(0);
    const rows = JSON.parse(result.stdout) as Array<{ memory: { id: string } }>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(2);
    expect(rows[0]!.memory.id).toMatch(/^mem_/);
  });

  it('--limit 1 caps the output', async () => {
    await bindAndImportTwo();
    const result = runCli(['memory', 'list', '--limit', '1']);
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    // salience-desc ordering: the salience-8 SQLite memory wins.
    expect(result.stdout).toContain('SQLite');
  });

  it('rejects a non-positive --limit', async () => {
    await bindAndImportTwo();
    const result = runCli(['memory', 'list', '--limit', '0']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--limit/i);
  });
});
