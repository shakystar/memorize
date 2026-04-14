import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-install-'));
  memorizeRoot = join(sandbox, '.memorize-home');
  await mkdir(join(sandbox, '.cursor', 'rules'), { recursive: true });
  await writeFile(join(sandbox, 'AGENTS.md'), '# Guidance\nUse small commits.\n', 'utf8');
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('install integration', () => {
  it('installs Claude hook configuration into the project', async () => {
    const result = runCli(['install', 'claude']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Installed Claude integration');

    const settings = await readFile(
      join(sandbox, '.claude', 'settings.local.json'),
      'utf8',
    );
    expect(settings).toContain('SessionStart');
    expect(settings).toContain('PreCompact');
    expect(settings).toContain('PostCompact');
    expect(settings).toContain('memorize hook claude SessionStart');
  });

  it('merges Claude settings without deleting existing hooks and is idempotent', async () => {
    await mkdir(join(sandbox, '.claude'), { recursive: true });
    await writeFile(
      join(sandbox, '.claude', 'settings.local.json'),
      JSON.stringify(
        {
          hooks: {
            Other: [{ command: 'keep-me' }],
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const first = runCli(['install', 'claude']);
    const second = runCli(['install', 'claude']);

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);

    const settings = JSON.parse(
      await readFile(join(sandbox, '.claude', 'settings.local.json'), 'utf8'),
    ) as {
      hooks: Record<string, Array<{ command: string }>>;
    };

    expect(settings.hooks.Other?.[0]?.command).toBe('keep-me');
    expect(
      settings.hooks.SessionStart?.filter(
        (entry) => entry.command === 'memorize hook claude SessionStart',
      ).length,
    ).toBe(1);
  });

  it('installs Codex integration artifacts into the project', async () => {
    const result = runCli(['install', 'codex']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Installed Codex integration');

    const override = await readFile(join(sandbox, 'AGENTS.override.md'), 'utf8');
    expect(override).toContain('memorize launch codex');
    expect(override).toContain('Memorize-managed bootstrap guidance');
  });

  it('merges Codex override content without destroying unrelated content and is idempotent', async () => {
    await writeFile(
      join(sandbox, 'AGENTS.override.md'),
      '# Existing override\n\nKeep this custom note.\n',
      'utf8',
    );

    const first = runCli(['install', 'codex']);
    const second = runCli(['install', 'codex']);

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);

    const override = await readFile(join(sandbox, 'AGENTS.override.md'), 'utf8');
    expect(override).toContain('# Existing override');
    expect(override).toContain('Keep this custom note.');
    expect(override).toContain('Memorize-managed bootstrap guidance');
    expect(
      override.match(/Memorize-managed bootstrap guidance/g)?.length ?? 0,
    ).toBe(1);
  });

  it('preserves content placed after the managed block on re-install', async () => {
    // First install starts from empty file.
    runCli(['install', 'codex']);

    // User edits the file to append content AFTER the managed block.
    const afterFirst = await readFile(
      join(sandbox, 'AGENTS.override.md'),
      'utf8',
    );
    await writeFile(
      join(sandbox, 'AGENTS.override.md'),
      `${afterFirst.trimEnd()}\n\n# Local overrides\n\n- custom rule\n`,
      'utf8',
    );

    // Second install must preserve the "Local overrides" content that sits
    // after the managed block.
    const second = runCli(['install', 'codex']);
    expect(second.status).toBe(0);

    const override = await readFile(
      join(sandbox, 'AGENTS.override.md'),
      'utf8',
    );
    expect(override).toContain('# Local overrides');
    expect(override).toContain('- custom rule');
    expect(override).toContain('Memorize-managed bootstrap guidance');
    expect(
      override.match(/Memorize-managed bootstrap guidance/g)?.length ?? 0,
    ).toBe(1);
  });

  it('migrates legacy Memorize markers to the versioned format', async () => {
    await writeFile(
      join(sandbox, 'AGENTS.override.md'),
      [
        '# Header',
        '',
        '<!-- Memorize:START -->',
        '# old managed block',
        '- ancient guidance',
        '<!-- Memorize:END -->',
        '',
        '# Footer section',
        'keep me too',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = runCli(['install', 'codex']);
    expect(result.status).toBe(0);

    const override = await readFile(
      join(sandbox, 'AGENTS.override.md'),
      'utf8',
    );
    expect(override).toContain('# Header');
    expect(override).toContain('# Footer section');
    expect(override).toContain('keep me too');
    expect(override).toContain('<!-- memorize:bootstrap v=1 start -->');
    expect(override).toContain('<!-- memorize:bootstrap v=1 end -->');
    expect(override).not.toContain('<!-- Memorize:START -->');
    expect(override).not.toContain('<!-- Memorize:END -->');
    expect(override).not.toContain('ancient guidance');
  });
});
