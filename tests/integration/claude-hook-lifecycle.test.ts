import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let sandbox: string;
let memorizeRoot: string;

const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

function runHook(eventName: string, stdinPayload: object) {
  return spawnSync('node', [tsxCliPath, cliEntryPath, 'hook', 'claude', eventName], {
    cwd: sandbox,
    input: JSON.stringify(stdinPayload),
    encoding: 'utf8',
    env: {
      ...process.env,
      MEMORIZE_ROOT: memorizeRoot,
    },
  });
}

function runCli(args: string[]) {
  return spawnSync('node', [tsxCliPath, cliEntryPath, ...args], {
    cwd: sandbox,
    encoding: 'utf8',
    env: {
      ...process.env,
      MEMORIZE_ROOT: memorizeRoot,
    },
  });
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-hook-lifecycle-'));
  memorizeRoot = join(sandbox, '.memorize-home');
  await mkdir(join(sandbox, '.cursor', 'rules'), { recursive: true });
  await writeFile(
    join(sandbox, 'AGENTS.md'),
    '# Project guidance\nUse small commits and keep handoffs explicit.\n',
    'utf8',
  );
  await writeFile(
    join(sandbox, 'CLAUDE.md'),
    '# Claude guidance\nPrioritize architectural consistency.\n',
    'utf8',
  );
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('claude hook lifecycle', () => {
  it('creates checkpoint artifacts on PostCompact', async () => {
    const sessionStart = runHook('SessionStart', {
      cwd: sandbox,
      hook_event_name: 'SessionStart',
      session_id: 'session_1',
    });
    expect(sessionStart.status).toBe(0);

    const result = runHook('PostCompact', {
      cwd: sandbox,
      hook_event_name: 'PostCompact',
      session_id: 'session_1',
      compact_summary: 'Summarized recent progress',
    });

    expect(result.status).toBe(0);
    // PostCompact output must be a plain top-level `systemMessage` —
    // Claude Code rejects a `hookSpecificOutput` block on this event.
    expect(result.stdout).not.toContain('"hookSpecificOutput"');
    expect(result.stdout).toContain('"systemMessage"');
    expect(result.stdout).toContain('memorize: checkpoint');

    const projectsRoot = join(memorizeRoot, 'projects');
    const projectDirs = await readdir(projectsRoot);
    const checkpointsDir = join(projectsRoot, projectDirs[0]!, 'checkpoints');
    const checkpointFiles = await readdir(checkpointsDir);
    expect(checkpointFiles.length).toBeGreaterThan(0);
  });

  it('creates a handoff-ready artifact on Stop when an active task exists', async () => {
    const sessionStart = runHook('SessionStart', {
      cwd: sandbox,
      hook_event_name: 'SessionStart',
      session_id: 'session_2',
    });
    expect(sessionStart.status).toBe(0);

    // Stop needs an active task to produce a meaningful handoff.
    const taskCreate = runCli(['task', 'create', 'Test task']);
    expect(taskCreate.status).toBe(0);

    const result = runHook('Stop', {
      cwd: sandbox,
      hook_event_name: 'Stop',
      session_id: 'session_2',
      last_assistant_message: 'Finished the current pass and prepared the next step.',
    });

    expect(result.status).toBe(0);
    // Stop output must be a plain top-level `systemMessage` — Claude
    // Code rejects a `hookSpecificOutput` block on this event.
    expect(result.stdout).not.toContain('"hookSpecificOutput"');
    expect(result.stdout).toContain('"systemMessage"');
    expect(result.stdout).toContain('memorize: handoff');

    const projectsRoot = join(memorizeRoot, 'projects');
    const projectDirs = await readdir(projectsRoot);
    const handoffsDir = join(projectsRoot, projectDirs[0]!, 'handoffs');
    const handoffFiles = await readdir(handoffsDir);
    expect(handoffFiles.length).toBeGreaterThan(0);

    const handoffContent = await readFile(join(handoffsDir, handoffFiles[0]!), 'utf8');
    expect(handoffContent).toContain('Finished the current pass');

    // Regression guard: the handoff's taskId must match a memorize task
    // id (task_*), not a Claude Code session UUID. A UUID-shaped taskId
    // would orphan the handoff from the projection and hide it from
    // `task resume`.
    const parsed = JSON.parse(handoffContent) as { taskId: string };
    expect(parsed.taskId).toMatch(/^task_[a-z0-9]+_[a-z0-9]+$/);
  });

  it('skips auto-handoff on Stop when no active task exists', async () => {
    const sessionStart = runHook('SessionStart', {
      cwd: sandbox,
      hook_event_name: 'SessionStart',
      session_id: 'session_3',
    });
    expect(sessionStart.status).toBe(0);

    // No task created — Stop must bail out cleanly rather than forge a
    // handoff whose taskId is a session UUID.
    const result = runHook('Stop', {
      cwd: sandbox,
      hook_event_name: 'Stop',
      session_id: 'session_3',
      last_assistant_message: 'nothing to hand off',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"systemMessage"');
    expect(result.stdout).toContain('no active task');
    expect(result.stdout).not.toContain('memorize: handoff');

    const projectsRoot = join(memorizeRoot, 'projects');
    const projectDirs = await readdir(projectsRoot);
    const handoffsDir = join(projectsRoot, projectDirs[0]!, 'handoffs');
    const handoffFiles = await readdir(handoffsDir).catch(() => []);
    expect(handoffFiles.length).toBe(0);
  });
});
