import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let sandbox: string;
let memorizeRoot: string;

const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

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
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-trust-surface-'));
  memorizeRoot = join(sandbox, '.memorize-home');
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('trust and repair surface', () => {
  it('exposes project inspect, projection rebuild, memory-index rebuild, events validate, and doctor', () => {
    const init = runCli(['project', 'init']);
    expect(init.status).toBe(0);

    const inspect = runCli(['project', 'inspect']);
    const rebuildProjection = runCli(['projection', 'rebuild']);
    const rebuildMemory = runCli(['memory-index', 'rebuild']);
    const validateEvents = runCli(['events', 'validate']);
    const doctor = runCli(['doctor']);

    expect(inspect.status).toBe(0);
    expect(rebuildProjection.status).toBe(0);
    expect(rebuildMemory.status).toBe(0);
    expect(validateEvents.status).toBe(0);
    expect(doctor.status).toBe(0);

    expect(inspect.stdout).toContain('"title"');
    expect(rebuildProjection.stdout).toContain('Projection rebuild complete');
    expect(rebuildMemory.stdout).toContain('Memory index rebuild complete');
    expect(validateEvents.stdout).toContain('Event validation passed');
    expect(doctor.stdout).toContain('Doctor check passed');
  });
});
