// scripts/benchmarks/e2e/reader.ts
import type { BenchSession } from '../retrieval/dataset.js';
import type { Chat } from './chat-client.js';

/** Char cap on the assembled context so the reader request fits the model
 *  window. Default ~12k chars (≈ 3k tokens) keeps a local qwen request safe;
 *  a strong reader (claude -p) can lift it via BENCH_READER_CHAR_BUDGET so the
 *  top-K gold sessions are not truncated. */
export const READER_CONTEXT_CHAR_BUDGET =
  Number(process.env.BENCH_READER_CHAR_BUDGET) || 12_000;

export async function answer(
  chat: Chat,
  question: string,
  sessions: BenchSession[],
): Promise<string> {
  let context = '';
  for (const session of sessions) {
    const remaining = READER_CONTEXT_CHAR_BUDGET - context.length;
    if (remaining <= 0) break;
    const header = `--- session ${session.sessionId} ---\n`;
    const full = `${header}${session.text}\n\n`;
    if (full.length <= remaining) {
      context += full;
    } else {
      const keep = Math.max(0, remaining - header.length - 2);
      context += `${header}${session.text.slice(0, keep)}\n\n`;
      break;
    }
  }
  const prompt =
    `You answer the question using ONLY the chat-history excerpts below. ` +
    `If the answer is not present in them, reply exactly: I don't know.\n\n` +
    `# Chat history\n${context}\n# Question\n${question}\n\n# Answer`;
  return (await chat.chat(prompt)).trim();
}
