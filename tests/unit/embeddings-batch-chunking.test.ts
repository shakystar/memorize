import { describe, expect, it } from 'vitest';

import {
  HttpEmbedder,
  MIN_EMBED_INPUT_CHARS,
} from '../../src/services/embeddings-service.js';

// A fake OpenAI-compatible /embeddings endpoint that mimics a context-window
// limit: it returns HTTP 400 when a request's combined input length exceeds
// `limitChars`, otherwise one embedding per input encoding its first char (so
// cross-chunk ordering is verifiable). Records every request's `input` array.
function fakeServer(limitChars: number, calls: string[][]): typeof fetch {
  return (async (_url: string, init: { body: string }) => {
    const { input } = JSON.parse(init.body) as { input: string[] };
    calls.push(input);
    const total = input.reduce((sum, t) => sum + t.length, 0);
    if (total > limitChars) {
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: { message: 'input length exceeds context' } }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        data: input.map((t, i) => ({ index: i, embedding: [t.charCodeAt(0)] })),
      }),
    };
  }) as unknown as typeof fetch;
}

function embedder(fetchImpl: typeof fetch): HttpEmbedder {
  return new HttpEmbedder({ endpoint: 'http://x/v1', model: 'm', fetchImpl });
}

describe('HttpEmbedder adaptive batch splitting', () => {
  it('halves a rejected sub-batch until it fits, preserving input order', async () => {
    const calls: string[][] = [];
    const inputs = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((c) =>
      c.repeat(1000),
    );

    const out = await embedder(fakeServer(4000, calls)).embed(inputs);

    // One vector per input, original order, across split boundaries.
    expect(out).toEqual(inputs.map((t) => [t.charCodeAt(0)]));
    // A sub-batch over the server limit was attempted (then split): proof the
    // adaptive path ran rather than every request fitting first try.
    expect(
      calls.some((c) => c.reduce((s, t) => s + t.length, 0) > 4000),
    ).toBe(true);
  });

  it('truncates and retries a single input the server keeps rejecting', async () => {
    const calls: string[][] = [];

    const out = await embedder(fakeServer(1500, calls)).embed([
      'Z'.repeat(5000),
    ]);

    expect(out).toEqual([['Z'.charCodeAt(0)]]);
    // The request that finally succeeded carried a truncated (<= limit) input.
    const lastInput = calls[calls.length - 1]![0]!;
    expect(lastInput.length).toBeLessThanOrEqual(1500);
    expect(lastInput.length).toBeGreaterThanOrEqual(MIN_EMBED_INPUT_CHARS);
  });

  it('sends a small batch as a single request (unchanged behavior)', async () => {
    const calls: string[][] = [];

    const out = await embedder(fakeServer(1_000_000, calls)).embed([
      'hi',
      'there',
    ]);

    expect(out).toEqual([['h'.charCodeAt(0)], ['t'.charCodeAt(0)]]);
    expect(calls).toHaveLength(1);
  });
});
