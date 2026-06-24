// scripts/benchmarks/e2e/judge.ts
import type { Chat } from './chat-client.js';

export interface JudgeInput {
  question: string;
  gold: string;
  answer: string;
  isAbstention: boolean;
}

export async function judge(chat: Chat, input: JudgeInput): Promise<boolean> {
  const criterion = input.isAbstention
    ? `The question is UNANSWERABLE from the user's history. The model is CORRECT ` +
      `only if it declined to answer or said it does not know / the information was not provided.`
    : `The model is CORRECT if its answer matches the gold answer in meaning (ignore wording).`;
  const prompt =
    `You are grading a model's answer. Reply with exactly one word: ` +
    `yes (correct) or no (incorrect).\n\n${criterion}\n\n` +
    `# Question\n${input.question}\n\n# Gold answer\n${input.gold}\n\n` +
    `# Model answer\n${input.answer}\n\n# Verdict (yes/no)`;
  const verdict = (await chat.chat(prompt)).trim().toLowerCase();
  const isYes = /^yes\b/.test(verdict);
  const isNo = /^no\b/.test(verdict);
  if (!isYes && !isNo) {
    process.stderr.write(`WARN: unparseable judge verdict: ${verdict.slice(0, 60)}\n`);
  }
  return isYes;
}
