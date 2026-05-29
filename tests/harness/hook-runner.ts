import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface HookRunOptions {
  agent: 'claude' | 'codex';
  event: string;
  payload?: unknown;
  sandbox: string;
  memorizeRoot: string;
  envFile?: string;
  extraEnv?: Record<string, string>;
}

export interface HookRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  envFileLines: string[];
}

const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

/**
 * Spawns `memorize hook <agent> <event>` as a subprocess and returns
 * stdout / stderr / exitCode plus, if `envFile` was provided, the
 * non-empty lines of the resulting env file. Mirrors the spawnSync
 * pattern used by the lifecycle / claude-hook integration tests so the
 * harness can replace ad-hoc helpers in those tests without behavior
 * drift.
 */
export function runHook(opts: HookRunOptions): HookRunResult {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MEMORIZE_ROOT: opts.memorizeRoot,
    ...(opts.envFile ? { CLAUDE_ENV_FILE: opts.envFile } : {}),
    ...(opts.extraEnv ?? {}),
  };

  const spawnOpts: Parameters<typeof spawnSync>[2] = {
    cwd: opts.sandbox,
    encoding: 'utf8',
    env,
  };
  if (opts.payload !== undefined) {
    spawnOpts.input = JSON.stringify(opts.payload);
  }

  const result = spawnSync(
    'node',
    [tsxCliPath, cliEntryPath, 'hook', opts.agent, opts.event],
    spawnOpts,
  );

  let envFileLines: string[] = [];
  if (opts.envFile && existsSync(opts.envFile)) {
    envFileLines = readFileSync(opts.envFile, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0);
  }

  return {
    stdout: typeof result.stdout === 'string' ? result.stdout : (result.stdout?.toString('utf8') ?? ''),
    stderr: typeof result.stderr === 'string' ? result.stderr : (result.stderr?.toString('utf8') ?? ''),
    exitCode: result.status,
    envFileLines,
  };
}
