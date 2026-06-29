import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

const piExtensionPath = () =>
  join(fakeHome, '.pi', 'agent', 'extensions', 'memorize.ts');
const piMcpConfigPath = () => join(fakeHome, '.pi', 'agent', 'mcp.json');

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-pi-'));
  fakeHome = join(sandbox, 'fake-home');
  memorizeRoot = join(sandbox, '.memorize-home');
  await mkdir(fakeHome, { recursive: true });
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('memorize init — pi', () => {
  it('detects pi via ~/.pi and wires the extension + MCP block + ground rule', async () => {
    // Detection signal: pi's config dir exists.
    await mkdir(join(fakeHome, '.pi'), { recursive: true });

    const result = runInit();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Initialized project');
    // pi notice mentions the session-start injection hook.
    expect(result.stdout).toContain('before_agent_start');

    // Capture+inject extension planted globally.
    expect(await pathExists(piExtensionPath())).toBe(true);
    const ext = await readFile(piExtensionPath(), 'utf8');
    // Subscribes to the three pi lifecycle events we rely on.
    expect(ext).toContain('before_agent_start');
    expect(ext).toContain('tool_result');
    expect(ext).toContain('session_compact');
    // Reaches memorize via `memorize hook pi <event>`.
    expect(ext).toContain("'pi'");

    // MCP block merged into ~/.pi/agent/mcp.json (Claude-format).
    const mcp = JSON.parse(await readFile(piMcpConfigPath(), 'utf8')) as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };
    expect(mcp.mcpServers?.memorize?.command).toBe('npx');
    expect(mcp.mcpServers?.memorize?.args).toContain('mcp');

    // Project AGENTS.md ground-rule block planted (pi reads AGENTS.md natively).
    expect(await readFile(join(sandbox, 'AGENTS.md'), 'utf8')).toContain(
      'memorize:ground-rule',
    );

    // No claude/codex/opencode side effects.
    expect(
      await pathExists(join(sandbox, '.claude', 'settings.local.json')),
    ).toBe(false);
    expect(
      await pathExists(join(fakeHome, '.config', 'opencode', 'opencode.json')),
    ).toBe(false);
  });

  it('is idempotent: re-running leaves exactly one memorize MCP entry and one ground-rule block', async () => {
    await mkdir(join(fakeHome, '.pi'), { recursive: true });

    expect(runInit().status).toBe(0);
    expect(runInit().status).toBe(0);

    const mcp = JSON.parse(await readFile(piMcpConfigPath(), 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(Object.keys(mcp.mcpServers ?? {})).toEqual(['memorize']);

    const agentsMd = await readFile(join(sandbox, 'AGENTS.md'), 'utf8');
    const blocks = agentsMd.match(/memorize:ground-rule v=1 start/g) ?? [];
    expect(blocks).toHaveLength(1);
  });

  it('preserves a user-defined MCP server when registering memorize', async () => {
    const agentDir = join(fakeHome, '.pi', 'agent');
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: { other: { command: 'other', args: [] } },
      }),
      'utf8',
    );

    expect(runInit().status).toBe(0);

    const mcp = JSON.parse(await readFile(piMcpConfigPath(), 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(Object.keys(mcp.mcpServers ?? {}).sort()).toEqual([
      'memorize',
      'other',
    ]);
  });
});
