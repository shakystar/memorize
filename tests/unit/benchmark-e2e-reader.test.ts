// tests/unit/benchmark-e2e-reader.test.ts
import { describe, expect, it } from 'vitest';

import { answer } from '../../scripts/benchmarks/e2e/reader.js';
import type { Chat } from '../../scripts/benchmarks/e2e/chat-client.js';

function capturingChat(): { chat: Chat; last: () => string } {
  let last = '';
  return {
    chat: { chat: async (p: string) => { last = p; return '  the answer  '; } },
    last: () => last,
  };
}

describe('benchmark/e2e reader', () => {
  it('puts the session text and question in the prompt and trims the answer', async () => {
    const c = capturingChat();
    const out = await answer(c.chat, 'What did I name my dog?', [
      { sessionId: 's1', text: 'user: We named the dog Max.' },
    ]);
    expect(out).toBe('the answer');
    expect(c.last()).toContain('We named the dog Max');
    expect(c.last()).toContain('What did I name my dog?');
  });

  it('stops adding sessions once the char budget is exceeded', async () => {
    const c = capturingChat();
    const big = 'x'.repeat(13000);
    await answer(c.chat, 'q', [
      { sessionId: 's1', text: big },
      { sessionId: 's2', text: 'SENTINEL second session' },
    ]);
    expect(c.last()).not.toContain('SENTINEL');
  });
});
