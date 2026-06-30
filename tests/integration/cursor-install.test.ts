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
      // Disable PATH-based detection so ONLY ~/.cursor triggers wiring.
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

interface CursorEntry {
  command: string;
  matcher?: string;
  timeout?: number;
}
interface CursorHooksFile {
  version?: number;
  hooks?: Record<string, CursorEntry[]>;
}
interface CursorMcpFile {
  mcpServers?: Record<string, { command?: string; args?: string[] }>;
}

// Cursor hooks/MCP are PER-PROJECT: they live in the sandbox cwd, not ~/.cursor.
const hooksPath = () => join(sandbox, '.cursor', 'hooks.json');
const mcpPath = () => join(sandbox, '.cursor', 'mcp.json');

const CURSOR_EVENTS = ['sessionStart', 'postToolUse', 'preCompact', 'sessionEnd'];

async function readHooks(): Promise<CursorHooksFile> {
  return JSON.parse(await readFile(hooksPath(), 'utf8')) as CursorHooksFile;
}
async function readMcp(): Promise<CursorMcpFile> {
  return JSON.parse(await readFile(mcpPath(), 'utf8')) as CursorMcpFile;
}
function memorizeEntries(entries: CursorEntry[] = []): CursorEntry[] {
  return entries.filter((e) => /hook cursor/.test(e.command ?? ''));
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-cursor-'));
  fakeHome = join(sandbox, 'fake-home');
  memorizeRoot = join(sandbox, '.memorize-home');
  await mkdir(fakeHome, { recursive: true });
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('memorize init — cursor', () => {
  it('detects cursor via ~/.cursor and wires .cursor/hooks.json + .cursor/mcp.json + ground rule', async () => {
    // Detection signal: cursor's config dir exists.
    await mkdir(join(fakeHome, '.cursor'), { recursive: true });

    const result = runInit();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Initialized project');
    // The cursor notice mentions the per-project hooks file.
    expect(result.stdout).toContain('.cursor/hooks.json');

    // hooks.json: version 1 envelope + one memorize hook per native event.
    expect(await pathExists(hooksPath())).toBe(true);
    const hooks = await readHooks();
    expect(hooks.version).toBe(1);
    for (const event of CURSOR_EVENTS) {
      const ours = memorizeEntries(hooks.hooks?.[event]);
      expect(ours).toHaveLength(1);
      expect(ours[0]!.command).toContain(`hook cursor ${event}`);
    }
    // postToolUse is capture-all → registered with NO matcher.
    expect(memorizeEntries(hooks.hooks?.postToolUse)[0]!.matcher).toBeUndefined();

    // MCP server merged into .cursor/mcp.json (Claude-format mcpServers).
    expect(await pathExists(mcpPath())).toBe(true);
    const mcp = await readMcp();
    expect(mcp.mcpServers?.memorize?.command).toBe('npx');
    expect(mcp.mcpServers?.memorize?.args).toContain('mcp');

    // Project AGENTS.md ground-rule block (cursor reads AGENTS.md natively).
    expect(await readFile(join(sandbox, 'AGENTS.md'), 'utf8')).toContain(
      'memorize:ground-rule',
    );

    // No claude/codex/opencode/hermes side effects.
    expect(
      await pathExists(join(sandbox, '.claude', 'settings.local.json')),
    ).toBe(false);
    expect(await pathExists(join(fakeHome, '.hermes', 'config.yaml'))).toBe(false);
  });

  it('is idempotent: re-running leaves exactly one memorize entry per event and one ground-rule block', async () => {
    await mkdir(join(fakeHome, '.cursor'), { recursive: true });

    expect(runInit().status).toBe(0);
    expect(runInit().status).toBe(0);

    const hooks = await readHooks();
    for (const event of CURSOR_EVENTS) {
      expect(memorizeEntries(hooks.hooks?.[event])).toHaveLength(1);
    }
    expect(Object.keys((await readMcp()).mcpServers ?? {})).toEqual(['memorize']);

    const agentsMd = await readFile(join(sandbox, 'AGENTS.md'), 'utf8');
    expect(agentsMd.match(/memorize:ground-rule v=1 start/g) ?? []).toHaveLength(
      1,
    );
  });

  it('preserves a user-defined hook and MCP server', async () => {
    await mkdir(join(fakeHome, '.cursor'), { recursive: true });
    await mkdir(join(sandbox, '.cursor'), { recursive: true });
    // User's own postToolUse hook + their own MCP server, pre-existing.
    await writeFile(
      hooksPath(),
      JSON.stringify({
        version: 1,
        hooks: { postToolUse: [{ command: 'echo user-hook' }] },
      }),
      'utf8',
    );
    await writeFile(
      mcpPath(),
      JSON.stringify({ mcpServers: { other: { command: 'other' } } }),
      'utf8',
    );

    expect(runInit().status).toBe(0);

    const hooks = await readHooks();
    // The user's hook survives alongside memorize's under postToolUse.
    const postEntries = hooks.hooks?.postToolUse ?? [];
    expect(postEntries.some((e) => e.command === 'echo user-hook')).toBe(true);
    expect(memorizeEntries(postEntries)).toHaveLength(1);
    // Both MCP servers present.
    expect(Object.keys((await readMcp()).mcpServers ?? {}).sort()).toEqual([
      'memorize',
      'other',
    ]);
  });
});
