import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readLastConsolidateAttempt } from '../../src/services/consolidate-service.js';
import { closeAll } from '../../src/storage/db.js';
import { readEvents } from '../../src/storage/event-store.js';

const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

let sandbox: string;
let memorizeRoot: string;

function cliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MEMORIZE_ROOT: memorizeRoot,
  };
  delete env.MEMORIZE_LLM_API_KEY; // force the rule-based extractor
  return env;
}

function runCli(args: string[], stdinPayload?: object) {
  return spawnSync(process.execPath, [tsxCliPath, cliEntryPath, ...args], {
    cwd: sandbox,
    encoding: 'utf8',
    env: cliEnv(),
    ...(stdinPayload ? { input: JSON.stringify(stdinPayload) } : {}),
  });
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-consolidate-cmd-'));
  memorizeRoot = join(sandbox, '.memorize-home');
});

afterEach(async () => {
  closeAll();
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

describe('memorize consolidate (CLI command — #46 Part A)', () => {
  it('consolidates the bound cwd project and is idempotent on re-run', async () => {
    // Bind the cwd + start a session via the SessionStart hook (the same
    // path the real install takes), then capture one observation.
    const start = runCli(['hook', 'claude', 'SessionStart'], {
      cwd: sandbox,
      hook_event_name: 'SessionStart',
      session_id: 'consolidate-cmd-uuid-1',
    });
    expect(start.status).toBe(0);

    const write = runCli(['hook', 'claude', 'PostToolUse'], {
      cwd: sandbox,
      hook_event_name: 'PostToolUse',
      session_id: 'consolidate-cmd-uuid-1',
      tool_name: 'Write',
      tool_input: { file_path: join(sandbox, 'feature.ts') },
    });
    expect(write.status).toBe(0);

    // The command under test: run one consolidation boundary for the cwd.
    const result = runCli(['consolidate']);
    expect(result.status).toBe(0);

    process.env.MEMORIZE_ROOT = memorizeRoot;
    closeAll();
    const projectDirs = await readdir(join(memorizeRoot, 'accounts', 'local_default', 'projects'));
    const types = (await readEvents(projectDirs[0]!)).map((e) => e.type);
    expect(
      types.filter((t) => t === 'memory.consolidated').length,
    ).toBeGreaterThan(0);
    closeAll();

    // Watermark advanced → a second run is a clean no-op (exit 0).
    const again = runCli(['consolidate']);
    expect(again.status).toBe(0);
  });

  it('accepts --boundary and records it; junk values fall back to manual (#51)', async () => {
    const start = runCli(['hook', 'claude', 'SessionStart'], {
      cwd: sandbox,
      hook_event_name: 'SessionStart',
      session_id: 'consolidate-cmd-uuid-2',
    });
    expect(start.status).toBe(0);
    const write = runCli(['hook', 'claude', 'PostToolUse'], {
      cwd: sandbox,
      hook_event_name: 'PostToolUse',
      session_id: 'consolidate-cmd-uuid-2',
      tool_name: 'Write',
      tool_input: { file_path: join(sandbox, 'feature.ts') },
    });
    expect(write.status).toBe(0);

    const result = runCli(['consolidate', '--boundary', 'post-compact']);
    expect(result.status).toBe(0);

    process.env.MEMORIZE_ROOT = memorizeRoot;
    closeAll();
    const projectDirs = await readdir(join(memorizeRoot, 'accounts', 'local_default', 'projects'));
    const attempt = readLastConsolidateAttempt(projectDirs[0]!);
    expect(attempt?.boundary).toBe('post-compact');
    expect(attempt?.outcome).toBe('ok');
    expect(attempt?.backend).toBe('rule-based'); // MEMORIZE_LLM_BACKEND=off
    closeAll();
    delete process.env.MEMORIZE_ROOT;

    // Junk boundary value must not fail the run — it reads as 'manual'.
    const junk = runCli(['consolidate', '--boundary', 'bogus-label']);
    expect(junk.status).toBe(0);

    process.env.MEMORIZE_ROOT = memorizeRoot;
    closeAll();
    const attempt2 = readLastConsolidateAttempt(projectDirs[0]!);
    expect(attempt2?.boundary).toBe('manual');
    expect(attempt2?.outcome).toBe('noop'); // watermark already advanced
    closeAll();
  });

  it('fails cleanly when the cwd is not bound to a project', async () => {
    const result = runCli(['consolidate']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No project bound');
  });

  it('--report dumps the #57 lifecycle-evidence distribution without running a boundary', async () => {
    const start = runCli(['hook', 'claude', 'SessionStart'], {
      cwd: sandbox,
      hook_event_name: 'SessionStart',
      session_id: 'consolidate-cmd-uuid-3',
    });
    expect(start.status).toBe(0);
    const write = runCli(['hook', 'claude', 'PostToolUse'], {
      cwd: sandbox,
      hook_event_name: 'PostToolUse',
      session_id: 'consolidate-cmd-uuid-3',
      tool_name: 'Write',
      tool_input: { file_path: join(sandbox, 'feature.ts') },
    });
    expect(write.status).toBe(0);
    expect(runCli(['consolidate']).status).toBe(0);

    const report = runCli(['consolidate', '--report']);
    expect(report.status).toBe(0);
    const parsed = JSON.parse(report.stdout) as {
      memories: number;
      byKind: Record<
        string,
        { count: number; withObsoleteWhen: number; kindMisfit: number }
      >;
      obsoleteWhen: unknown[];
      kindMisfitReasons: unknown[];
      behavior: {
        memories: number;
        byKind: Record<
          string,
          { count: number; totalInjections: number; superseded: number }
        >;
      };
    };
    // Rule-based extractor emits no evidence fields — presence counters are
    // all zero, but the shape is complete and counts the real memories.
    expect(parsed.memories).toBeGreaterThan(0);
    expect(parsed.byKind.progress!.count).toBeGreaterThan(0);
    expect(parsed.byKind.progress!.withObsoleteWhen).toBe(0);
    expect(parsed.obsoleteWhen).toEqual([]);
    expect(parsed.kindMisfitReasons).toEqual([]);
    // #62 — the behavioral half rides the same report. Nothing was injected
    // or superseded in this fresh store, but the shape and counts are there.
    expect(parsed.behavior.memories).toBe(parsed.memories);
    expect(parsed.behavior.byKind.progress!.count).toBe(
      parsed.byKind.progress!.count,
    );
    expect(parsed.behavior.byKind.progress!.totalInjections).toBe(0);
    expect(parsed.behavior.byKind.progress!.superseded).toBe(0);

    // --report is read-only: the recorded last attempt is still the boundary
    // run above, not a new one.
    process.env.MEMORIZE_ROOT = memorizeRoot;
    closeAll();
    const projectDirs = await readdir(join(memorizeRoot, 'accounts', 'local_default', 'projects'));
    const attempt = readLastConsolidateAttempt(projectDirs[0]!);
    expect(attempt?.outcome).toBe('ok');
    closeAll();
  });
});
