// scripts/benchmarks/e2e/reader.ts
import type { BenchSession } from '../retrieval/dataset.js';
import type { Chat } from './chat-client.js';

/** Char cap on the assembled history so the reader request fits the model
 *  window. Default ~12k chars (≈ 3k tokens) keeps a local qwen request safe;
 *  a strong reader (claude -p) can lift it via BENCH_READER_CHAR_BUDGET so the
 *  top-K gold sessions are not truncated. */
export const READER_CONTEXT_CHAR_BUDGET =
  Number(process.env.BENCH_READER_CHAR_BUDGET) || 12_000;

/** Concatenate the retrieved sessions (each with its date) up to the char
 *  budget, truncating the block that would overflow. */
function assembleHistory(sessions: BenchSession[]): string {
  let history = '';
  for (const session of sessions) {
    const remaining = READER_CONTEXT_CHAR_BUDGET - history.length;
    if (remaining <= 0) break;
    const header = `Session Date: ${session.date ?? 'Unknown'}\nSession ${session.sessionId}:\n`;
    const block = `${header}${session.text}\n\n`;
    if (block.length <= remaining) {
      history += block;
    } else {
      const keep = Math.max(0, remaining - header.length - 2);
      history += `${header}${session.text.slice(0, keep)}\n\n`;
      break;
    }
  }
  return history;
}

/** LongMemEval QA reader, using the benchmark's official direct + chain-of-
 *  thought generation prompt: present the retrieved sessions and ask the model
 *  to first extract the relevant information, then reason to an answer. Letting
 *  the model abstain naturally (rather than forcing a fixed "I don't know")
 *  preserves the abstention questions. */
export async function answer(
  chat: Chat,
  question: string,
  sessions: BenchSession[],
  questionDate?: string,
): Promise<string> {
  const history = assembleHistory(sessions);
  const prompt =
    `I will give you several history chats between you and a user. ` +
    `Please answer the question based on the relevant chat history. ` +
    `Answer the question step by step: first extract all the relevant ` +
    `information, and then reason over the information to get the answer.\n\n\n` +
    `History Chats:\n\n${history}\n` +
    `Current Date: ${questionDate ?? 'Unknown'}\n` +
    `Question: ${question}\n` +
    `Answer (step by step):`;
  return (await chat.chat(prompt)).trim();
}
