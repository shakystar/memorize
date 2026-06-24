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
          if (e === 'close') cb(0);
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

  it('resolveChat defaults reader to http/Ollama and judge to cli/claude', () => {
    const reader = resolveChat('reader', {});
    const judge = resolveChat('judge', {});
    expect(reader).toBeInstanceOf(HttpChat);
    expect(judge).toBeInstanceOf(CliChat);
  });
});
