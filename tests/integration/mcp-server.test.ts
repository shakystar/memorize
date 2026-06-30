import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let sandbox: string;
let fakeHome: string;
let memorizeRoot: string;

const repoRoot = process.cwd();
const tsxCliPath = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliEntryPath = join(repoRoot, 'src', 'cli', 'index.ts');

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  return {
    ...env,
    MEMORIZE_ROOT: memorizeRoot,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    MEMORIZE_DETECT_PATH: '',
    // Keep the spawned server self-contained: no detached consolidation /
    // update-check children racing the test sandbox teardown.
    MEMORIZE_CONSOLIDATE_INLINE: '1',
    MEMORIZE_UPDATE_CHECK_DISABLED: '1',
  };
}

/** Bind the sandbox to a memorize project (no agents → just binds + imports). */
function bindProject(): void {
  const result = spawnSync('node', [tsxCliPath, cliEntryPath, 'init'], {
    cwd: sandbox,
    encoding: 'utf8',
    env: childEnv(),
  });
  expect(result.status).toBe(0);
}

function showProject(): SpawnSyncReturns<string> {
  return spawnSync('node', [tsxCliPath, cliEntryPath, 'project', 'show'], {
    cwd: sandbox,
    encoding: 'utf8',
    env: childEnv(),
  });
}

async function connectClient(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [tsxCliPath, cliEntryPath, 'mcp'],
    cwd: sandbox,
    env: childEnv(),
  });
  const client = new Client({ name: 'test-harness', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-mcp-'));
  fakeHome = join(sandbox, 'fake-home');
  memorizeRoot = join(sandbox, '.memorize-home');
  await mkdir(fakeHome, { recursive: true });
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('memorize mcp server', () => {
  it('advertises the memory toolset over stdio', async () => {
    bindProject();
    const client = await connectClient();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          'memorize_consolidate',
          'memorize_context',
          'memorize_diagnose',
          'memorize_recall',
          'memorize_record',
        ].sort(),
      );
    } finally {
      await client.close();
    }
  }, 30_000);

  it('records a memory and recalls it; diagnose returns a structured report', async () => {
    bindProject();
    const client = await connectClient();
    try {
      const recorded = await client.callTool({
        name: 'memorize_record',
        arguments: {
          items: [
            {
              kind: 'decision',
              text: 'Adopt the harness registry as the single source of truth for adapters.',
              salience: 8,
            },
          ],
        },
      });
      expect(textOf(recorded as never)).toMatch(/Recorded 1/);

      const recalled = await client.callTool({
        name: 'memorize_recall',
        arguments: { query: 'harness registry single source of truth' },
      });
      // FTS snippets wrap matched tokens in brackets and may truncate, so match
      // a single distinctive token rather than the verbatim phrase.
      expect(textOf(recalled as never)).toMatch(/harness/i);

      const diagnosed = await client.callTool({
        name: 'memorize_diagnose',
        arguments: {},
      });
      const report = JSON.parse(textOf(diagnosed as never)) as { status: string };
      expect(['ok', 'warn', 'error']).toContain(report.status);
    } finally {
      await client.close();
    }
  }, 30_000);

  it('record reports not-bound (isError) when the cwd is not a memorize project', async () => {
    // No bindProject() — the sandbox has no project binding.
    const client = await connectClient();
    try {
      const result = await client.callTool({
        name: 'memorize_record',
        arguments: { items: [{ kind: 'progress', text: 'x' }] },
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(textOf(result as never)).toMatch(/memorize init/);
    } finally {
      await client.close();
    }
  }, 30_000);

  it('context reports not-bound without initializing the cwd', async () => {
    // No bindProject() ??memorize_context is read-only and must not create one.
    const client = await connectClient();
    try {
      const result = await client.callTool({
        name: 'memorize_context',
        arguments: {},
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(textOf(result as never)).toMatch(/not bound/);
    } finally {
      await client.close();
    }

    const show = showProject();
    expect(show.status).not.toBe(0);
    expect(show.stderr).toContain('No project bound');
  }, 30_000);
});
