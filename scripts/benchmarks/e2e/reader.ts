// scripts/benchmarks/e2e/reader.ts
import type { BenchSession } from '../retrieval/dataset.js';
import type { Chat } from './chat-client.js';

/** Char cap on the assembled context so the reader request fits the model
 *  window (esp. local qwen). ~12k chars ≈ 3k tokens. */
export const READER_CONTEXT_CHAR_BUDGET = 12_000;

export async function answer(
  chat: Chat,
  question: string,
  sessions: BenchSession[],
): Promise<string> {
  let context = '';
  for (const session of sessions) {
    const block = `--- session ${session.sessionId} ---\n${session.text}\n\n`;
    if (context.length > 0 && context.length + block.length > READER_CONTEXT_CHAR_BUDGET) {
      break;
    }
    context += block;
  }
  const prompt =
    `You answer the question using ONLY the chat-history excerpts below. ` +
    `If the answer is not present in them, reply exactly: I don't know.\n\n` +
    `# Chat history\n${context}\n# Question\n${question}\n\n# Answer`;
  return (await chat.chat(prompt)).trim();
}
