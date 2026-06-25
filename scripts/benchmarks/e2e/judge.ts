// scripts/benchmarks/e2e/judge.ts
import type { Chat } from './chat-client.js';

export interface JudgeInput {
  question: string;
  gold: string;
  answer: string;
  isAbstention: boolean;
  /** LongMemEval question type; selects the official per-type grading rubric.
   *  Optional — an unknown/missing type falls back to the general rubric. */
  questionType?: string;
}

/** The official LongMemEval grading rubric, verbatim per question type
 *  (src/evaluation/evaluate_qa.py). The judge replies "yes"/"no" only. */
function rubric(input: JudgeInput): string {
  if (input.isAbstention) {
    return (
      `I will give you an unanswerable question, an explanation, and a response ` +
      `from a model. Please answer yes if the model correctly identifies the ` +
      `question as unanswerable. The model could say that the information is ` +
      `incomplete, or some other information is given but the asked information ` +
      `is not provided.`
    );
  }
  if (input.questionType === 'single-session-preference') {
    return (
      `I will give you a question, a rubric for desired personalized response, ` +
      `and a response from a model. Please answer yes if the response satisfies ` +
      `the desired response. Otherwise, answer no. The model does not need to ` +
      `reflect all the points in the rubric. The response is correct as long as ` +
      `it recalls and utilizes the user's personal information correctly.`
    );
  }
  const base =
    `I will give you a question, a correct answer, and a response from a model. ` +
    `Please answer yes if the response contains the correct answer. Otherwise, ` +
    `answer no. If the response is equivalent to the correct answer or contains ` +
    `all the intermediate steps to get the correct answer, you should also ` +
    `answer yes. If the response only contains a subset of the information ` +
    `required by the answer, answer no.`;
  if (input.questionType === 'temporal-reasoning') {
    return (
      base +
      ` In addition, do not penalize off-by-one errors for the number of days. ` +
      `If the question asks for the number of days/weeks/months, etc., and the ` +
      `model makes off-by-one errors (e.g., predicting 19 days when the answer ` +
      `is 18), the model's response is still correct.`
    );
  }
  if (input.questionType === 'knowledge-update') {
    return (
      base +
      ` If the response contains some previous information along with an updated ` +
      `answer, the response should be considered as correct as long as the ` +
      `updated answer is the required answer.`
    );
  }
  return base;
}

export async function judge(chat: Chat, input: JudgeInput): Promise<boolean> {
  const goldLabel = input.isAbstention
    ? 'Explanation'
    : input.questionType === 'single-session-preference'
      ? 'Rubric'
      : 'Correct Answer';
  const prompt =
    `${rubric(input)}\n\n` +
    `Question: ${input.question}\n` +
    `${goldLabel}: ${input.gold}\n` +
    `Model Response: ${input.answer}\n\n` +
    `Is the model response correct? Answer yes or no only.`;
  // Official metric: a verdict counts as correct iff it contains "yes".
  const verdict = (await chat.chat(prompt)).trim().toLowerCase();
  const hasYes = verdict.includes('yes');
  const hasNo = verdict.includes('no');
  if (!hasYes && !hasNo) {
    process.stderr.write(`WARN: unparseable judge verdict: ${verdict.slice(0, 60)}\n`);
  }
  return hasYes;
}
