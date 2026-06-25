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
  it('puts the session text and question in the official CoT prompt and trims the answer', async () => {
    const c = capturingChat();
    const out = await answer(c.chat, 'What did I name my dog?', [
      { sessionId: 's1', text: 'user: We named the dog Max.' },
    ]);
    expect(out).toBe('the answer');
    expect(c.last()).toContain('We named the dog Max');
    expect(c.last()).toContain('Question: What did I name my dog?');
    // Official direct + chain-of-thought instruction drives extract-then-reason.
    expect(c.last()).toContain('first extract all the relevant information');
    expect(c.last()).toContain('Answer (step by step):');
  });

  it('includes the session date and the question (current) date when provided', async () => {
    const c = capturingChat();
    await answer(
      c.chat,
      'q',
      [{ sessionId: 's1', text: 'fact', date: '2023/05/20 (Sat) 02:21' }],
      '2023/05/30 (Tue) 23:40',
    );
    expect(c.last()).toContain('Session Date: 2023/05/20 (Sat) 02:21');
    expect(c.last()).toContain('Current Date: 2023/05/30 (Tue) 23:40');
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

  it('includes text from multiple small sessions when each fits within budget', async () => {
    const c = capturingChat();
    const text1 = 'A'.repeat(5000);
    const text2 = 'B'.repeat(5000);
    await answer(c.chat, 'q', [
      { sessionId: 'sA', text: text1 },
      { sessionId: 'sB', text: text2 },
    ]);
    expect(c.last()).toContain('Session sA');
    expect(c.last()).toContain('Session sB');
  });
});
