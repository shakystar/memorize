import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { cloneFixtureToTmp } from '../fixtures/clone-fixture-to-tmp.js';

const repoRoot = process.cwd();
const tsxCliPath = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntryPath = path.join(repoRoot, 'src', 'cli', 'index.ts');

export interface BenchmarkResult {
  benchmark: string;
  fixture: string;
  status: 'pass' | 'fail';
  durationMs: number;
  metrics: Record<string, number>;
  artifacts: Record<string, string>;
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

export function runCliInSandbox(params: {
  cwd: string;
  memorizeRoot: string;
  args: string[];
}): ReturnType<typeof spawnSync> {
  return spawnSync('node', [tsxCliPath, cliEntryPath, ...params.args], {
    cwd: params.cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      MEMORIZE_ROOT: params.memorizeRoot,
    },
  });
}

export async function withFixture<T>(
  fixtureName: string,
  callback: (ctx: Awaited<ReturnType<typeof cloneFixtureToTmp>>) => Promise<T>,
): Promise<T> {
  const cloned = await cloneFixtureToTmp(fixtureName);
  const previousRoot = process.env.MEMORIZE_ROOT;
  process.env.MEMORIZE_ROOT = cloned.memorizeRoot;
  try {
    return await callback(cloned);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.MEMORIZE_ROOT;
    } else {
      process.env.MEMORIZE_ROOT = previousRoot;
    }
    await cloned.cleanup();
  }
}
