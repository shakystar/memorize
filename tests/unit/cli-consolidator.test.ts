import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createObservation } from '../../src/domain/entities.js';
import {
  CliConsolidator,
  ExtractionParseError,
  SUPPRESS_HOOKS_ENV_VAR,
  resolveConsolidatorBackend,
  type SpawnImpl,
} from '../../src/services/consolidate-service.js';
import {
  runClaudeHook,
  runCodexHook,
} from '../../src/services/hook-service.js';

// resolveConsolidatorBackend warns to stderr on an unknown explicit value.
// Silence stderr so test output stays clean.
let stderrSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  stderrSpy.mockRestore();
});

// --- backend resolution (#44 priority order) ---------------------------------

const notOnPath = () => false;
const onPath =
  (...commands: string[]) =>
  (command: string) =>
    commands.includes(command);

describe('resolveConsolidatorBackend (#44 priority order)', () => {
  it('explicit claude-cli wins over an API key', () => {
    expect(
      resolveConsolidatorBackend(
        { MEMORIZE_LLM_BACKEND: 'claude-cli', MEMORIZE_LLM_API_KEY: 'sk-x' },
        notOnPath,
      ),
    ).toEqual({ kind: 'cli', command: 'claude' });
  });

  it('explicit codex-cli selects the codex CLI', () => {
    expect(
      resolveConsolidatorBackend({ MEMORIZE_LLM_BACKEND: 'codex-cli' }, notOnPath),
    ).toEqual({ kind: 'cli', command: 'codex' });
  });

  it('off disables LLM entirely (rule-based, even with key + CLI on PATH)', () => {
    expect(
      resolveConsolidatorBackend(
        { MEMORIZE_LLM_BACKEND: 'off', MEMORIZE_LLM_API_KEY: 'sk-x' },
        onPath('claude', 'codex'),
      ),
    ).toEqual({ kind: 'rule-based' });
  });

  it('unknown explicit value is treated as unset (falls through)', () => {
    expect(
      resolveConsolidatorBackend(
        { MEMORIZE_LLM_BACKEND: 'gemini-cli' },
        onPath('claude'),
      ),
    ).toEqual({ kind: 'cli', command: 'claude' });
  });

  it('API key beats CLI auto-detect (existing HTTP behavior unchanged)', () => {
    const backend = resolveConsolidatorBackend(
      { MEMORIZE_LLM_API_KEY: 'sk-x' },
      onPath('claude'),
    );
    expect(backend.kind).toBe('llm');
  });

  it('auto-detects claude on PATH before codex', () => {
    expect(resolveConsolidatorBackend({}, onPath('claude', 'codex'))).toEqual({
      kind: 'cli',
      command: 'claude',
    });
    expect(resolveConsolidatorBackend({}, onPath('codex'))).toEqual({
      kind: 'cli',
      command: 'codex',
    });
  });

  it('nothing available → rule-based', () => {
    expect(resolveConsolidatorBackend({}, notOnPath)).toEqual({
      kind: 'rule-based',
    });
  });

  it('MEMORIZE_LLM_TIMEOUT_MS flows into the CLI backend', () => {
    expect(
      resolveConsolidatorBackend(
        { MEMORIZE_LLM_BACKEND: 'claude-cli', MEMORIZE_LLM_TIMEOUT_MS: '60000' },
        notOnPath,
      ),
    ).toEqual({ kind: 'cli', command: 'claude', timeoutMs: 60_000 });
  });
});

// --- CliConsolidator ----------------------------------------------------------

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdinData = '';
  wasKilled = false;
  stdin = {
    end: (data: string) => {
      this.stdinData += data;
    },
  };
  kill(): boolean {
    this.wasKilled = true;
    this.emit('close', null);
    return true;
  }
}

interface SpawnCall {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function fakeSpawn(
  child: FakeChild,
  onSpawn?: () => void,
): { spawnImpl: SpawnImpl; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawnImpl: SpawnImpl = (command, args, options) => {
    calls.push({ command, args, env: options.env });
    if (onSpawn) queueMicrotask(onSpawn);
    return child;
  };
  return { spawnImpl, calls };
}

const sampleInput = {
  observations: [
    createObservation({
      projectId: 'proj_cliunit_test1',
      signal: 'decision-keyword' as const,
      toolName: 'Bash',
      summary: 'Decided to use sqlite for the event store',
    }),
  ],
  existingMemories: [],
};

describe('CliConsolidator (host-CLI extractor — #44)', () => {
  it('parses memories from stdout; prompt via stdin; suppress-hooks env set', async () => {
    const child = new FakeChild();
    const { spawnImpl, calls } = fakeSpawn(child, () => {
      child.stdout.emit(
        'data',
        '[{"kind":"decision","text":"Use sqlite","salience":8}]',
      );
      child.emit('close', 0);
    });

    const consolidator = new CliConsolidator({ command: 'claude', spawnImpl });
    const extracted = await consolidator.extract(sampleInput);

    expect(extracted).toEqual([
      { kind: 'decision', text: 'Use sqlite', salience: 8 },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('claude');
    expect(calls[0]!.args).toEqual(['-p', '--output-format', 'text']);
    // Recursion guard: the spawned CLI's own memorize hooks must no-op.
    expect(calls[0]!.env[SUPPRESS_HOOKS_ENV_VAR]).toBe('1');
    // Prompt arrives via stdin (not argv), with system prompt prepended.
    expect(child.stdinData).toContain('memory consolidator');
    expect(child.stdinData).toContain('## Observations');
    expect(child.stdinData).toContain('Decided to use sqlite');
  });

  it('uses codex exec with stdin marker for the codex backend', async () => {
    const child = new FakeChild();
    const { spawnImpl, calls } = fakeSpawn(child, () => {
      child.stdout.emit('data', '[]');
      child.emit('close', 0);
    });

    const consolidator = new CliConsolidator({ command: 'codex', spawnImpl });
    await consolidator.extract(sampleInput);

    expect(calls[0]!.command).toBe('codex');
    expect(calls[0]!.args[0]).toBe('exec');
    expect(calls[0]!.args).toContain('-');
    expect(child.stdinData).toContain('## Observations');
  });

  it('throws ExtractionParseError on junk stdout (watermark must not advance)', async () => {
    const child = new FakeChild();
    const { spawnImpl } = fakeSpawn(child, () => {
      child.stdout.emit('data', 'I could not find anything durable, sorry!');
      child.emit('close', 0);
    });

    const consolidator = new CliConsolidator({ command: 'claude', spawnImpl });
    await expect(consolidator.extract(sampleInput)).rejects.toThrow(
      ExtractionParseError,
    );
  });

  it('throws on non-zero exit code', async () => {
    const child = new FakeChild();
    const { spawnImpl } = fakeSpawn(child, () => {
      child.stderr.emit('data', 'not logged in');
      child.emit('close', 1);
    });

    const consolidator = new CliConsolidator({ command: 'claude', spawnImpl });
    await expect(consolidator.extract(sampleInput)).rejects.toThrow(
      /exited with code 1/,
    );
  });

  it('throws on empty stdout even with exit code 0', async () => {
    const child = new FakeChild();
    const { spawnImpl } = fakeSpawn(child, () => {
      child.emit('close', 0);
    });

    const consolidator = new CliConsolidator({ command: 'claude', spawnImpl });
    await expect(consolidator.extract(sampleInput)).rejects.toThrow(
      /no output/,
    );
  });

  it('kills the child and THROWS on timeout (never returns [])', async () => {
    const child = new FakeChild();
    // Child never produces output or exits on its own.
    const { spawnImpl } = fakeSpawn(child);

    const consolidator = new CliConsolidator({
      command: 'claude',
      timeoutMs: 20,
      spawnImpl,
    });
    // Explicit timeoutMs overrides the built-in default.
    await expect(consolidator.extract(sampleInput)).rejects.toThrow(
      /timed out after 20ms/,
    );
    expect(child.wasKilled).toBe(true);
  });

  it('defaults to the 90s host-CLI timeout when timeoutMs is unset (#55)', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      // Child never produces output or exits on its own.
      const { spawnImpl } = fakeSpawn(child);

      const consolidator = new CliConsolidator({ command: 'claude', spawnImpl });
      const pending = consolidator.extract(sampleInput);
      const expectation = expect(pending).rejects.toThrow(
        /timed out after 90000ms/,
      );

      // The old shared 20s HTTP default must NOT kill a real `claude -p`
      // extraction (~31.5s measured) — still alive just before 90s.
      await vi.advanceTimersByTimeAsync(89_999);
      expect(child.wasKilled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(child.wasKilled).toBe(true);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects on spawn error (CLI missing at exec time)', async () => {
    const child = new FakeChild();
    const { spawnImpl } = fakeSpawn(child, () => {
      child.emit('error', new Error('spawn claude ENOENT'));
    });

    const consolidator = new CliConsolidator({ command: 'claude', spawnImpl });
    await expect(consolidator.extract(sampleInput)).rejects.toThrow(/ENOENT/);
  });
});

// --- hook recursion guard ------------------------------------------------------

describe('MEMORIZE_SUPPRESS_HOOKS recursion guard (hook entry points)', () => {
  let memorizeRoot: string;

  beforeEach(async () => {
    memorizeRoot = await mkdtemp(join(tmpdir(), 'memorize-suppress-'));
    process.env.MEMORIZE_ROOT = memorizeRoot;
    process.env[SUPPRESS_HOOKS_ENV_VAR] = '1';
  });

  afterEach(async () => {
    delete process.env[SUPPRESS_HOOKS_ENV_VAR];
    delete process.env.MEMORIZE_ROOT;
    await rm(memorizeRoot, { recursive: true, force: true });
  });

  it('claude hooks return the empty result without creating any state', async () => {
    for (const eventName of ['SessionStart', 'PostToolUse', 'SessionEnd']) {
      const result = await runClaudeHook({
        eventName,
        cwd: memorizeRoot,
        stdinPayload: JSON.stringify({ session_id: 'agent-uuid-suppressed' }),
      });
      expect(result).toBe('{}');
    }
    // Nothing was captured or bound — MEMORIZE_ROOT stayed empty.
    expect(await readdir(memorizeRoot)).toEqual([]);
  });

  it('codex hooks return the empty result without creating any state', async () => {
    const result = await runCodexHook({
      eventName: 'PostToolUse',
      cwd: memorizeRoot,
      stdinPayload: JSON.stringify({ session_id: 'agent-uuid-suppressed' }),
    });
    expect(result).toBe('{}');
    expect(await readdir(memorizeRoot)).toEqual([]);
  });
});
