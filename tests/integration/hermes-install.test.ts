import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { parse as parseYaml } from 'yaml';
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
      // Disable PATH-based detection so ONLY ~/.hermes triggers wiring.
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

interface HermesEntry {
  command: string;
  timeout?: number;
}
interface HermesConfig {
  hooks?: Record<string, HermesEntry[]>;
  mcp_servers?: Record<string, { command?: string; args?: string[] }>;
  [k: string]: unknown;
}
interface HermesAllowlist {
  approvals?: Array<{ event?: string; command?: string }>;
}

const configPath = () => join(fakeHome, '.hermes', 'config.yaml');
const allowlistPath = () =>
  join(fakeHome, '.hermes', 'shell-hooks-allowlist.json');

const HERMES_EVENTS = ['pre_llm_call', 'post_tool_call', 'on_session_finalize'];

async function readConfig(): Promise<HermesConfig> {
  return parseYaml(await readFile(configPath(), 'utf8')) as HermesConfig;
}
async function readAllowlist(): Promise<HermesAllowlist> {
  return JSON.parse(await readFile(allowlistPath(), 'utf8')) as HermesAllowlist;
}
function memorizeEntries(entries: HermesEntry[] = []): HermesEntry[] {
  return entries.filter((e) => /hook hermes/.test(e.command ?? ''));
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-hermes-'));
  fakeHome = join(sandbox, 'fake-home');
  memorizeRoot = join(sandbox, '.memorize-home');
  await mkdir(fakeHome, { recursive: true });
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('memorize init — hermes', () => {
  it('detects hermes via ~/.hermes and wires config.yaml hooks + MCP + allowlist + ground rule', async () => {
    // Detection signal: hermes's config dir exists.
    await mkdir(join(fakeHome, '.hermes'), { recursive: true });

    const result = runInit();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Initialized project');
    // The hermes notice mentions the per-session injection hook.
    expect(result.stdout).toContain('pre_llm_call');

    // config.yaml: one memorize hook per native event, pointing at our CLI.
    expect(await pathExists(configPath())).toBe(true);
    const config = await readConfig();
    for (const event of HERMES_EVENTS) {
      const ours = memorizeEntries(config.hooks?.[event]);
      expect(ours).toHaveLength(1);
      expect(ours[0]!.command).toContain(`hook hermes ${event}`);
    }
    // pre_llm_call BLOCKS the turn → carries an explicit timeout.
    expect(memorizeEntries(config.hooks?.pre_llm_call)[0]!.timeout).toBe(20);

    // MCP server merged into the SAME config.yaml (hermes-native mcp_servers).
    expect(config.mcp_servers?.memorize?.command).toBe('npx');
    expect(config.mcp_servers?.memorize?.args).toContain('mcp');

    // Allowlist pre-approves memorize's exact (event, command) pairs so the
    // hooks run without the interactive first-use prompt.
    expect(await pathExists(allowlistPath())).toBe(true);
    const allowlist = await readAllowlist();
    const ours = (allowlist.approvals ?? []).filter((a) =>
      /hook hermes/.test(a.command ?? ''),
    );
    expect(ours).toHaveLength(3);
    for (const event of HERMES_EVENTS) {
      const approval = ours.find((a) => a.event === event);
      expect(approval).toBeDefined();
      // The allowlist command MUST be byte-identical to the config command.
      expect(approval!.command).toBe(
        memorizeEntries(config.hooks?.[event])[0]!.command,
      );
    }

    // Project AGENTS.md ground-rule block (hermes reads AGENTS.md natively).
    expect(await readFile(join(sandbox, 'AGENTS.md'), 'utf8')).toContain(
      'memorize:ground-rule',
    );

    // No claude/codex/opencode/pi side effects.
    expect(
      await pathExists(join(sandbox, '.claude', 'settings.local.json')),
    ).toBe(false);
    expect(
      await pathExists(join(fakeHome, '.config', 'opencode', 'opencode.json')),
    ).toBe(false);
    expect(
      await pathExists(join(fakeHome, '.pi', 'agent', 'extensions', 'memorize.ts')),
    ).toBe(false);
  });

  it('is idempotent: re-running leaves exactly one memorize entry per event, one approval per event, one ground-rule block', async () => {
    await mkdir(join(fakeHome, '.hermes'), { recursive: true });

    expect(runInit().status).toBe(0);
    expect(runInit().status).toBe(0);

    const config = await readConfig();
    for (const event of HERMES_EVENTS) {
      expect(memorizeEntries(config.hooks?.[event])).toHaveLength(1);
    }
    expect(Object.keys(config.mcp_servers ?? {})).toEqual(['memorize']);

    const allowlist = await readAllowlist();
    const ours = (allowlist.approvals ?? []).filter((a) =>
      /hook hermes/.test(a.command ?? ''),
    );
    expect(ours).toHaveLength(3);

    const agentsMd = await readFile(join(sandbox, 'AGENTS.md'), 'utf8');
    expect(agentsMd.match(/memorize:ground-rule v=1 start/g) ?? []).toHaveLength(
      1,
    );
  });

  it('preserves a user-defined hook, MCP server, and allowlist approval', async () => {
    const hermesDir = join(fakeHome, '.hermes');
    await mkdir(hermesDir, { recursive: true });
    // User's own pre_llm_call hook + their own MCP server.
    await writeFile(
      configPath(),
      `hooks:\n  pre_llm_call:\n    - command: "echo user-hook"\nmcp_servers:\n  other:\n    command: other\n`,
      'utf8',
    );
    // User's own allowlist approval for an unrelated tool.
    await writeFile(
      allowlistPath(),
      JSON.stringify({
        approvals: [{ event: 'pre_tool_call', command: '/usr/bin/other-hook' }],
      }),
      'utf8',
    );

    expect(runInit().status).toBe(0);

    const config = await readConfig();
    // The user's hook survives alongside memorize's under pre_llm_call.
    const preEntries = config.hooks?.pre_llm_call ?? [];
    expect(preEntries.some((e) => e.command === 'echo user-hook')).toBe(true);
    expect(memorizeEntries(preEntries)).toHaveLength(1);
    // Both MCP servers present.
    expect(Object.keys(config.mcp_servers ?? {}).sort()).toEqual([
      'memorize',
      'other',
    ]);

    const allowlist = await readAllowlist();
    // User approval preserved; memorize approvals added (3 + 1).
    expect(
      (allowlist.approvals ?? []).some(
        (a) => a.command === '/usr/bin/other-hook',
      ),
    ).toBe(true);
    expect(allowlist.approvals).toHaveLength(4);
  });
});
