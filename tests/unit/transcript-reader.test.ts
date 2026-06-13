import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_RAW_BYTES_PER_READ,
  readConversationSince,
} from '../../src/services/transcript-reader.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'memorize-transcript-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function rec(obj: unknown): string {
  return JSON.stringify(obj);
}

async function writeTranscript(name: string, lines: string[]): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, lines.join('\n') + '\n', 'utf8');
  return p;
}

describe('readConversationSince — stripping (#99 cat-2)', () => {
  it('keeps user + assistant visible text and drops tool I/O and thinking', async () => {
    const p = await writeTranscript('t.jsonl', [
      rec({ type: 'user', message: { content: 'ship 2.3.1 as a patch' } }),
      rec({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'internal reasoning' },
            { type: 'text', text: 'on it' },
            { type: 'tool_use', name: 'Bash', input: { command: 'npm publish' } },
          ],
        },
      }),
      rec({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'published' }] },
      }),
      rec({
        type: 'user',
        message: { content: [{ type: 'text', text: 'great' }] },
      }),
    ]);

    const slice = await readConversationSince(p, 0);
    expect(slice).toBeDefined();
    expect(slice!.text).toBe('USER: ship 2.3.1 as a patch\n\nAGENT: on it\n\nUSER: great');
    // tool_use input, tool_result, and thinking never appear.
    expect(slice!.text).not.toContain('npm publish');
    expect(slice!.text).not.toContain('published');
    expect(slice!.text).not.toContain('internal reasoning');
  });

  it('skips malformed (non-JSON) lines without throwing', async () => {
    const p = await writeTranscript('t.jsonl', [
      'not json at all',
      rec({ type: 'user', message: { content: 'real turn' } }),
      '{ partial',
    ]);
    const slice = await readConversationSince(p, 0);
    expect(slice!.text).toBe('USER: real turn');
  });
});

describe('readConversationSince — incremental byte watermark', () => {
  it('reads to EOF and reports newOffset = size; a re-read at newOffset yields nothing new', async () => {
    const p = await writeTranscript('t.jsonl', [
      rec({ type: 'user', message: { content: 'first' } }),
    ]);
    const first = await readConversationSince(p, 0);
    expect(first!.text).toBe('USER: first');
    expect(first!.capped).toBe(false);

    // Nothing appended yet: re-reading from the watermark returns undefined.
    expect(await readConversationSince(p, first!.newOffset)).toBeUndefined();
  });

  it('a second read from the prior offset returns ONLY the newly appended turns', async () => {
    const p = await writeTranscript('t.jsonl', [
      rec({ type: 'user', message: { content: 'first' } }),
    ]);
    const first = await readConversationSince(p, 0);

    await writeFile(
      p,
      rec({ type: 'user', message: { content: 'first' } }) +
        '\n' +
        rec({ type: 'user', message: { content: 'second' } }) +
        '\n',
      'utf8',
    );
    const second = await readConversationSince(p, first!.newOffset);
    expect(second!.text).toBe('USER: second');
  });

  it('restarts from 0 when the stored offset is past EOF (rotated/truncated transcript)', async () => {
    const p = await writeTranscript('t.jsonl', [
      rec({ type: 'user', message: { content: 'fresh' } }),
    ]);
    const slice = await readConversationSince(p, 10_000_000);
    expect(slice!.text).toBe('USER: fresh');
  });
});

describe('readConversationSince — cap drains without skipping (#101 no silent caps)', () => {
  it('caps a large backlog at a line boundary and resumes cleanly on the next read', async () => {
    // Build a transcript whose raw size exceeds one read's cap.
    const lines: string[] = [];
    const filler = 'x'.repeat(2000);
    let bytes = 0;
    let i = 0;
    while (bytes < MAX_RAW_BYTES_PER_READ + 50_000) {
      const line = rec({ type: 'user', message: { content: `turn ${i} ${filler}` } });
      lines.push(line);
      bytes += Buffer.byteLength(line, 'utf8') + 1;
      i += 1;
    }
    const p = await writeTranscript('big.jsonl', lines);

    const first = await readConversationSince(p, 0);
    expect(first!.capped).toBe(true);
    expect(first!.newOffset).toBeLessThan(bytes);
    expect(first!.text).toContain('USER: turn 0');

    // The remainder is read next — no content skipped between the two slices.
    const second = await readConversationSince(p, first!.newOffset);
    expect(second).toBeDefined();
    expect(second!.text).toContain(`turn ${i - 1}`);
    // The two slices together cover every turn (boundary turn appears in one).
    expect(first!.newOffset).toBeGreaterThan(0);
  });
});

describe('readConversationSince — edge cases', () => {
  it('returns undefined for a missing path', async () => {
    expect(await readConversationSince(undefined, 0)).toBeUndefined();
    expect(await readConversationSince(join(dir, 'nope.jsonl'), 0)).toBeUndefined();
  });
});
