// scripts/benchmarks/e2e/reader.ts
import type { BenchSession } from '../retrieval/dataset.js';
import type { Chat } from './chat-client.js';

/** Char cap on the assembled history so the reader request fits the model
 *  window. Default ~12k chars (≈ 3k tokens) keeps a local qwen request safe;
 *  a strong reader (claude -p) can lift it via BENCH_READER_CHAR_BUDGET so the
 *  top-K gold sessions are not truncated. */
export const READER_CONTEXT_CHAR_BUDGET =
  Number(process.env.BENCH_READER_CHAR_BUDGET) || 12_000;

/** Parse a LongMemEval date ("2023/05/20 (Sat) 02:21") to epoch ms; NaN when
 *  absent/unparseable. The weekday in parens is dropped — only the YYYY/MM/DD
 *  HH:MM core is parsed, so it works on every engine. */
export function parseBenchDate(date: string | undefined): number {
  if (!date) return NaN;
  const m = date.match(/(\d{4})\/(\d{2})\/(\d{2})(?:\D+(\d{2}):(\d{2}))?/);
  if (!m) return NaN;
  const [, y, mo, d, hh, mm] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh ?? 0), Number(mm ?? 0));
}

/** Relative-age suffix vs the current date, e.g. " [18 days before current
 *  date]" — gives the reader the day arithmetic it otherwise re-derives from
 *  prose, the temporal-reasoning failure mode (#180). Empty when either date is
 *  missing/unparseable. */
function ageSuffix(sessionDate: string | undefined, questionDate?: string): string {
  const s = parseBenchDate(sessionDate);
  const q = parseBenchDate(questionDate);
  if (Number.isNaN(s) || Number.isNaN(q)) return '';
  const days = Math.round((q - s) / 86_400_000);
  return days < 0
    ? ` [${-days} days after current date]`
    : ` [${days} days before current date]`;
}

/** Assemble the retrieved sessions into the reader context.
 *
 *  Two stages, deliberately ordered:
 *  1. SELECT by retrieval RANK (input order) until the char budget is full —
 *     the ranking must decide WHAT the reader sees. (A prior version sorted
 *     chronologically BEFORE truncating, so a high-rank-but-recent gold session
 *     was dropped by the budget cut — gold present in top-K yet invisible to the
 *     reader.) Whole sessions only; the first session alone is truncated if it
 *     exceeds the budget.
 *  2. DISPLAY the selected sessions oldest→newest so cross-session temporal/
 *     count reasoning sees a timeline; each header carries the session's age. */
function assembleHistory(sessions: BenchSession[], questionDate?: string): string {
  const header = (s: BenchSession): string =>
    `Session Date: ${s.date ?? 'Unknown'}${ageSuffix(s.date, questionDate)}\n` +
    `Session ${s.sessionId}:\n`;

  const selected: { session: BenchSession; text: string }[] = [];
  let used = 0;
  for (const session of sessions) {
    const block = `${header(session)}${session.text}\n\n`;
    if (used === 0 && block.length > READER_CONTEXT_CHAR_BUDGET) {
      const keep = Math.max(0, READER_CONTEXT_CHAR_BUDGET - header(session).length - 2);
      selected.push({ session, text: session.text.slice(0, keep) });
      break;
    }
    if (used + block.length > READER_CONTEXT_CHAR_BUDGET) break;
    selected.push({ session, text: session.text });
    used += block.length;
  }

  return selected
    .map((s, i) => ({ ...s, i, t: parseBenchDate(s.session.date) }))
    .sort((a, b) => {
      const at = Number.isNaN(a.t) ? Infinity : a.t;
      const bt = Number.isNaN(b.t) ? Infinity : b.t;
      return at === bt ? a.i - b.i : at - bt;
    })
    .map((x) => `${header(x.session)}${x.text}\n\n`)
    .join('');
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
  const history = assembleHistory(sessions, questionDate);
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
