import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let sandbox: string;
let fakeHome: string;
let memorizeRoot: string;

const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

function runInit() {
  return spawnSync('node', [tsxCliPath, cliEntryPath, 'init'], {
    cwd: sandbox,
    encoding: 'utf8',
    env: {
      ...process.env,
      MEMORIZE_ROOT: memorizeRoot,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      MEMORIZE_DETECT_PATH: '',
      MEMORIZE_HOOK_COMMAND_FORM: 'npx',
    },
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const opencodeConfigPath = () =>
  join(fakeHome, '.config', 'opencode', 'opencode.json');
const opencodePluginPath = () =>
  join(fakeHome, '.config', 'opencode', 'plugins', 'memorize.ts');

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-opencode-'));
  fakeHome = join(sandbox, 'fake-home');
  memorizeRoot = join(sandbox, '.memorize-home');
  await mkdir(fakeHome, { recursive: true });
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('memorize init — opencode', () => {
  it('detects opencode via ~/.config/opencode and wires MCP + plugin + ground rule', async () => {
    // Detection signal: opencode's config dir exists.
    await mkdir(join(fakeHome, '.config', 'opencode'), { recursive: true });

    const result = runInit();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Initialized project');
    // opencode session-start memory is delivered via MCP, surfaced in the notice.
    expect(result.stdout).toContain('memorize_context');

    // MCP server registered in opencode.json.
    const config = JSON.parse(await readFile(opencodeConfigPath(), 'utf8')) as {
      mcp?: Record<string, { type?: string; command?: string[] }>;
      instructions?: string[];
    };
    expect(config.mcp?.memorize?.type).toBe('local');
    expect(config.mcp?.memorize?.command).toContain('mcp');
    // AGENTS.md added to the instructions list so opencode loads the ground rule.
    expect(config.instructions).toContain('AGENTS.md');

    // Capture plugin planted globally.
    expect(await pathExists(opencodePluginPath())).toBe(true);
    const plugin = await readFile(opencodePluginPath(), 'utf8');
    expect(plugin).toContain('tool.execute.after');
    expect(plugin).toContain('hook');

    // Project AGENTS.md ground-rule block planted.
    expect(await readFile(join(sandbox, 'AGENTS.md'), 'utf8')).toContain(
      'memorize:ground-rule',
    );

    // No claude/codex side effects.
    expect(
      await pathExists(join(sandbox, '.claude', 'settings.local.json')),
    ).toBe(false);
    expect(await pathExists(join(fakeHome, '.codex', 'hooks.json'))).toBe(false);
  });

  it('is idempotent: re-running leaves exactly one memorize MCP entry and one ground-rule block', async () => {
    await mkdir(join(fakeHome, '.config', 'opencode'), { recursive: true });

    expect(runInit().status).toBe(0);
    expect(runInit().status).toBe(0);

    const config = JSON.parse(await readFile(opencodeConfigPath(), 'utf8')) as {
      mcp?: Record<string, unknown>;
      instructions?: string[];
    };
    expect(Object.keys(config.mcp ?? {})).toEqual(['memorize']);
    // AGENTS.md appears once in instructions, not duplicated.
    expect(
      (config.instructions ?? []).filter((i) => i === 'AGENTS.md'),
    ).toHaveLength(1);

    const agentsMd = await readFile(join(sandbox, 'AGENTS.md'), 'utf8');
    const blocks = agentsMd.match(/memorize:ground-rule v=1 start/g) ?? [];
    expect(blocks).toHaveLength(1);
  });

  it('preserves a user-defined MCP server when registering memorize', async () => {
    const cfgDir = join(fakeHome, '.config', 'opencode');
    await mkdir(cfgDir, { recursive: true });
    await import('node:fs/promises').then((fs) =>
      fs.writeFile(
        join(cfgDir, 'opencode.json'),
        JSON.stringify({
          mcp: { other: { type: 'local', command: ['other'], enabled: true } },
        }),
        'utf8',
      ),
    );

    expect(runInit().status).toBe(0);

    const config = JSON.parse(await readFile(opencodeConfigPath(), 'utf8')) as {
      mcp?: Record<string, unknown>;
    };
    expect(Object.keys(config.mcp ?? {}).sort()).toEqual(['memorize', 'other']);
  });
});
