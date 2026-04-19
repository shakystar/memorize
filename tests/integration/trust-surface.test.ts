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
  it('exposes project inspect, projection rebuild, memory-index rebuild, events validate, and doctor', { timeout: 30_000 }, () => {
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

  it('emits a parseable JSON report via doctor --json', { timeout: 30_000 }, () => {
    const init = runCli(['project', 'init']);
    expect(init.status).toBe(0);

    const result = runCli(['doctor', '--json']);
    expect(result.status).toBe(0);

    const report = JSON.parse(String(result.stdout)) as {
      status: string;
      version: string;
      checks: Array<{ id: string; status: string }>;
      issues: Array<{ id: string; severity: string }>;
    };
    expect(report.status).toBe('ok');
    expect(report.version).toBe('1');
    expect(report.issues).toEqual([]);
    expect(report.checks.some((check) => check.id === 'project.bound')).toBe(
      true,
    );
    expect(
      report.checks.every((check) => check.status === 'ok'),
    ).toBe(true);
  });

  it('fails doctor with structured issues when no project is bound', { timeout: 30_000 }, () => {
    const result = runCli(['doctor', '--json']);
    expect(result.status).toBe(1);

    const report = JSON.parse(String(result.stdout)) as {
      status: string;
      issues: Array<{ id: string; severity: string; fix?: string }>;
    };
    expect(report.status).toBe('error');
    const bound = report.issues.find((issue) => issue.id === 'project.bound');
    expect(bound?.severity).toBe('error');
    expect(bound?.fix).toBe('memorize project init');
  });

  it('warns when .memorize/ is not listed in .gitignore for a git repo', { timeout: 30_000 }, () => {
    spawnSync('git', ['init', '-q'], { cwd: sandbox });
    runCli(['project', 'init']);

    const result = runCli(['doctor', '--json']);
    const report = JSON.parse(String(result.stdout)) as {
      status: string;
      checks: Array<{ id: string; status: string; fix?: string }>;
      issues: Array<{ id: string; severity: string; fix?: string }>;
    };
    expect(report.status).toBe('warn');
    const redaction = report.issues.find(
      (issue) => issue.id === 'git.ignore.memorize',
    );
    expect(redaction?.severity).toBe('warn');
    expect(redaction?.fix).toBe("add '.memorize/' to .gitignore");
  });

  it('passes redaction check when .memorize/ is gitignored', { timeout: 30_000 }, async () => {
    spawnSync('git', ['init', '-q'], { cwd: sandbox });
    await (await import('node:fs/promises')).writeFile(
      join(sandbox, '.gitignore'),
      '.memorize/\n',
      'utf8',
    );
    runCli(['project', 'init']);

    const result = runCli(['doctor', '--json']);
    expect(result.status).toBe(0);

    const report = JSON.parse(String(result.stdout)) as {
      status: string;
      checks: Array<{ id: string; status: string }>;
    };
    expect(report.status).toBe('ok');
    expect(
      report.checks.find((check) => check.id === 'git.ignore.memorize')?.status,
    ).toBe('ok');
  });
});
