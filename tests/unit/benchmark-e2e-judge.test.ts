// tests/unit/benchmark-e2e-judge.test.ts
import { describe, expect, it } from 'vitest';

import { judge } from '../../scripts/benchmarks/e2e/judge.js';
import type { Chat } from '../../scripts/benchmarks/e2e/chat-client.js';

const fixedChat = (reply: string): Chat => ({ chat: async () => reply });

describe('benchmark/e2e judge', () => {
  it('parses a leading yes as correct and anything else as incorrect', async () => {
    expect(await judge(fixedChat('yes, matches'), {
      question: 'q', gold: 'Max', answer: 'Max', isAbstention: false,
    })).toBe(true);
    expect(await judge(fixedChat('no'), {
      question: 'q', gold: 'Max', answer: 'Rex', isAbstention: false,
    })).toBe(false);
    expect(await judge(fixedChat('garbled'), {
      question: 'q', gold: 'Max', answer: 'Rex', isAbstention: false,
    })).toBe(false);
  });

  it('includes the abstention criterion in the prompt for _abs questions', async () => {
    let prompt = '';
    const chat: Chat = { chat: async (p) => { prompt = p; return 'yes'; } };
    await judge(chat, { question: 'q', gold: 'not provided', answer: "I don't know", isAbstention: true });
    expect(prompt.toLowerCase()).toContain('unanswerable');
  });
});
