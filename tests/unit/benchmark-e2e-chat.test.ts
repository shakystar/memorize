// tests/unit/benchmark-e2e-chat.test.ts
import { describe, expect, it } from 'vitest';

import {
  CliChat,
  HttpChat,
  resolveChat,
} from '../../scripts/benchmarks/e2e/chat-client.js';

describe('benchmark/e2e chat-client', () => {
  it('HttpChat posts an OpenAI-compatible request at temperature 0 and returns the content', async () => {
    let captured: { url: string; body: Record<string, unknown> } | undefined;
    const fetchImpl = (async (url: string, init: { body: string }) => {
      captured = { url, body: JSON.parse(init.body) };
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'hello' } }] }),
      };
    }) as unknown as typeof fetch;

    const out = await new HttpChat({
      endpoint: 'http://x/v1',
      model: 'm',
      fetchImpl,
    }).chat('hi');

    expect(out).toBe('hello');
    expect(captured!.url).toBe('http://x/v1/chat/completions');
    expect(captured!.body.temperature).toBe(0);
    expect(captured!.body.model).toBe('m');
  });

  it('CliChat spawns the command, pipes the prompt to stdin, suppresses hooks, and returns stdout', async () => {
    let spawnArgs: { cmd: string; args: string[]; env: Record<string, string> } | undefined;
    let stdinData = '';
    const fakeSpawn = ((cmd: string, args: string[], opts: { env: Record<string, string> }) => {
      spawnArgs = { cmd, args, env: opts.env };
      const handlers: Record<string, (arg?: unknown) => void> = {};
      return {
        stdout: { on: (_e: string, cb: (c: string) => void) => cb('  graded: yes  ') },
        stderr: { on: () => {} },
        stdin: { end: (d: string) => { stdinData = d; } },
        on: (e: string, cb: (arg?: unknown) => void) => {
          handlers[e] = cb;
          if (e === 'close') Promise.resolve().then(() => cb(0));
        },
        kill: () => {},
      };
    }) as unknown as typeof import('cross-spawn');

    const out = await new CliChat('claude', 1000, fakeSpawn).chat('PROMPT');

    expect(out).toBe('graded: yes'); // trimmed
    expect(spawnArgs!.cmd).toBe('claude');
    expect(spawnArgs!.args).toEqual(['-p', '--output-format', 'text']);
    expect(spawnArgs!.env.MEMORIZE_SUPPRESS_HOOKS).toBe('1');
    expect(stdinData).toBe('PROMPT');
  });

  it('HttpChat throws when the response has no content (fail loud, not empty string)', async () => {
    const fetchImpl = (async () => ({ ok: true, json: async () => ({ choices: [] }) })) as unknown as typeof fetch;
    await expect(
      new HttpChat({ endpoint: 'http://x/v1', model: 'm', fetchImpl }).chat('hi'),
    ).rejects.toThrow(/missing choices/);
  });

  it('resolveChat defaults reader to http/Ollama and judge to cli/claude', () => {
    const reader = resolveChat('reader', {});
    const judge = resolveChat('judge', {});
    expect(reader).toBeInstanceOf(HttpChat);
    expect(judge).toBeInstanceOf(CliChat);
  });

  it('resolveChat honors a CLI timeout override and rejects a bad value', () => {
    const reader = resolveChat('reader', {
      BENCH_READER_BACKEND: 'cli',
      BENCH_READER_CLI_TIMEOUT_MS: '300000',
    });
    expect((reader as CliChat).timeoutMs).toBe(300000);
    expect(() =>
      resolveChat('reader', { BENCH_READER_BACKEND: 'cli', BENCH_READER_CLI_TIMEOUT_MS: 'nope' }),
    ).toThrow(/positive number/);
  });

  it('CliChat timeout calls killImpl and rejects with /timed out/', async () => {
    let killImplCalls = 0;
    let closeHandler: ((code: number | null) => void) | undefined;
    const fakeKillImpl = () => {
      killImplCalls++;
      // Simulate the OS firing 'close' after the process tree is killed
      Promise.resolve().then(() => closeHandler?.(null));
    };
    const fakeSpawn = ((_cmd: string, _args: string[], _opts: unknown) => {
      return {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        stdin: { end: () => {} },
        kill: () => {},
        pid: 12345,
        on: (e: string, cb: (arg?: unknown) => void) => {
          if (e === 'close') closeHandler = cb as (code: number | null) => void;
          // Never fire 'error' or 'close' spontaneously — simulates a hung process
        },
      };
    }) as unknown as typeof import('cross-spawn');

    await expect(
      new CliChat('claude', 30, fakeSpawn, fakeKillImpl).chat('PROMPT'),
    ).rejects.toThrow(/timed out/);
    expect(killImplCalls).toBe(1);
  });

  it('HttpChat includes options.num_ctx when num_ctx is set', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      capturedBody = JSON.parse(init.body) as Record<string, unknown>;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      };
    }) as unknown as typeof fetch;

    await new HttpChat({ endpoint: 'http://x/v1', model: 'm', fetchImpl, num_ctx: 8192 }).chat('hi');
    expect((capturedBody!.options as Record<string, unknown>).num_ctx).toBe(8192);
  });

  it('HttpChat omits options field when num_ctx is not set', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      capturedBody = JSON.parse(init.body) as Record<string, unknown>;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      };
    }) as unknown as typeof fetch;

    await new HttpChat({ endpoint: 'http://x/v1', model: 'm', fetchImpl }).chat('hi');
    expect(capturedBody!.options).toBeUndefined();
  });
});
