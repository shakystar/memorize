import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeAll } from '../../src/storage/db.js';

const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

let sandbox: string;
let memorizeRoot: string;

function runCli(args: string[], input?: string) {
  return spawnSync(process.execPath, [tsxCliPath, cliEntryPath, ...args], {
    cwd: sandbox,
    encoding: 'utf8',
    env: { ...process.env, MEMORIZE_ROOT: memorizeRoot },
    ...(input !== undefined ? { input } : {}),
  });
}

/** Bind cwd to a fresh project via the SessionStart hook. */
function bindProject(): void {
  const start = runCli(
    ['hook', 'claude', 'SessionStart'],
    JSON.stringify({
      cwd: sandbox,
      hook_event_name: 'SessionStart',
      session_id: 'decision-read-uuid-1',
    }),
  );
  expect(start.status).toBe(0);
}

/** Record a decision; return its id (parsed from the confirmation line). */
function addDecision(title: string, decision: string, rationale?: string): string {
  const args = ['project', 'decision', 'add', '--title', title, '--decision', decision];
  if (rationale) args.push('--rationale', rationale);
  const result = runCli(args);
  expect(result.status).toBe(0);
  const m = result.stdout.match(/Recorded decision (\S+)/);
  expect(m).toBeTruthy();
  return m![1]!;
}

beforeEach(async () => {
  // os.tmpdir() is a symlink on macOS (/var -> /private/var); canonicalize so
  // the spawned CLI's process.cwd() matches the binding key.
  sandbox = await realpath(await mkdtemp(join(tmpdir(), 'memorize-decread-')));
  memorizeRoot = join(sandbox, '.memorize-home');
  process.env.MEMORIZE_ROOT = memorizeRoot;
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('memorize project decision list/show (CLI)', () => {
  it('list defaults to accepted decisions only (excludes superseded), newest first', () => {
    bindProject();
    const first = addDecision('Use SQLite', 'Store the index in SQLite');
    const second = addDecision('Use FTS5', 'Add full-text search via FTS5');

    // Supersede the first so it leaves the accepted set.
    const sup = runCli([
      'project', 'decision', 'supersede', first,
      '--title', 'Use SQLite + WAL',
      '--decision', 'Store the index in SQLite with WAL mode',
    ]);
    expect(sup.status).toBe(0);

    const listed = runCli(['project', 'decision', 'list']);
    expect(listed.status).toBe(0);
    // Default excludes the superseded decision.
    expect(listed.stdout).not.toContain(first);
    // Includes the still-accepted ones.
    expect(listed.stdout).toContain(second);
    // Tab-separated id\tstatus\ttitle.
    expect(listed.stdout).toMatch(new RegExp(`${second}\\taccepted\\tUse FTS5`));
  });

  it('--all includes superseded decisions', () => {
    bindProject();
    const first = addDecision('Use SQLite', 'Store the index in SQLite');
    const sup = runCli([
      'project', 'decision', 'supersede', first,
      '--title', 'Use SQLite + WAL',
      '--decision', 'Store the index in SQLite with WAL mode',
    ]);
    expect(sup.status).toBe(0);

    const def = runCli(['project', 'decision', 'list']);
    expect(def.stdout).not.toContain(first);

    const all = runCli(['project', 'decision', 'list', '--all']);
    expect(all.status).toBe(0);
    expect(all.stdout).toContain(first);
    expect(all.stdout).toMatch(new RegExp(`${first}\\tsuperseded`));
  });

  it('--json emits the raw decision array', () => {
    bindProject();
    const id = addDecision('Adopt event sourcing', 'The log is the source of truth', 'Replays');

    const result = runCli(['project', 'decision', 'list', '--json']);
    expect(result.status).toBe(0);
    const arr = JSON.parse(result.stdout) as Array<{
      id: string;
      status: string;
      title: string;
      decision: string;
    }>;
    const found = arr.find((d) => d.id === id);
    expect(found).toBeDefined();
    expect(found!.status).toBe('accepted');
    expect(found!.title).toBe('Adopt event sourcing');
  });

  it('show prints a single decision in full', () => {
    bindProject();
    const id = addDecision('Adopt event sourcing', 'The log is the source of truth', 'Enables replay');

    const result = runCli(['project', 'decision', 'show', id]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(id);
    expect(result.stdout).toContain('Adopt event sourcing');
    expect(result.stdout).toContain('The log is the source of truth');
    expect(result.stdout).toContain('Enables replay');
    expect(result.stdout).toMatch(/accepted/);
  });

  it('show --json emits the structured decision', () => {
    bindProject();
    const id = addDecision('Adopt event sourcing', 'The log is the source of truth');

    const result = runCli(['project', 'decision', 'show', id, '--json']);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      id: string;
      title: string;
      decision: string;
      status: string;
    };
    expect(payload.id).toBe(id);
    expect(payload.title).toBe('Adopt event sourcing');
    expect(payload.decision).toBe('The log is the source of truth');
    expect(payload.status).toBe('accepted');
  });

  it('show fails with a clear error and non-zero exit for an unknown id', () => {
    bindProject();
    const result = runCli(['project', 'decision', 'show', 'dec_does_not_exist']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/dec_does_not_exist/);
    expect(result.stderr).toMatch(/not found|no decision/i);
  });

  it('show fails with usage when no id is given', () => {
    bindProject();
    const result = runCli(['project', 'decision', 'show']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/id/i);
  });
});
