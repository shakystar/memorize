// scripts/benchmarks/retrieval/dataset.ts
import fs from 'node:fs';
import path from 'node:path';

export interface BenchSession {
  sessionId: string;
  text: string;
  /** When the session took place (LongMemEval haystack_dates). Optional so the
   *  retrieval fixtures, which carry no dates, still parse. */
  date?: string;
}

export interface BenchQuestion {
  questionId: string;
  question: string;
  questionType: string;
  sessions: BenchSession[];
  goldSessionIds: string[];
  answer: string | null;
  isAbstention: boolean;
  /** "Current date" the question is asked on (LongMemEval question_date);
   *  the QA reader needs it for temporal-reasoning. Optional for fixtures. */
  questionDate?: string;
}

export const DATASET_PATH = path.join(
  process.cwd(),
  'scripts/benchmarks/retrieval/data/longmemeval_s_cleaned.json',
);

interface RawTurn {
  role?: string;
  content?: string;
}
interface RawQuestion {
  question_id?: string;
  question_type?: string;
  question?: string;
  question_date?: string;
  haystack_session_ids?: string[];
  haystack_sessions?: RawTurn[][];
  haystack_dates?: string[];
  answer_session_ids?: string[];
  answer?: unknown;
}

function flattenSession(turns: RawTurn[]): string {
  return turns
    .map((t) => `${t.role ?? 'user'}: ${t.content ?? ''}`)
    .join('\n');
}

export function parseDataset(raw: unknown): BenchQuestion[] {
  if (!Array.isArray(raw)) {
    throw new Error('dataset: expected a top-level JSON array of questions');
  }
  return raw.map((item, i) => {
    const q = item as RawQuestion;
    const ids = q.haystack_session_ids;
    const sessions = q.haystack_sessions;
    if (
      q.question_id == null ||
      q.question == null ||
      !Array.isArray(ids) ||
      !Array.isArray(sessions) ||
      !Array.isArray(q.answer_session_ids)
    ) {
      throw new Error(
        `dataset[${i}] (question_id=${q.question_id ?? '?'}): missing one of ` +
          `question_id/question/haystack_session_ids/haystack_sessions/answer_session_ids`,
      );
    }
    if (ids.length !== sessions.length) {
      throw new Error(
        `dataset[${i}] (${q.question_id}): haystack_session_ids (${ids.length}) ` +
          `!= haystack_sessions (${sessions.length})`,
      );
    }
    const dates = q.haystack_dates;
    return {
      questionId: q.question_id,
      question: q.question,
      questionType: q.question_type ?? 'unknown',
      sessions: ids.map((sessionId, j) => ({
        sessionId,
        text: flattenSession(sessions[j] ?? []),
        ...(Array.isArray(dates) && dates[j] ? { date: dates[j] } : {}),
      })),
      goldSessionIds: q.answer_session_ids,
      answer:
        typeof q.answer === 'string' && q.answer.length > 0
          ? q.answer
          : typeof q.answer === 'number'
            ? String(q.answer)
            : null,
      isAbstention: q.question_id.endsWith('_abs'),
      ...(q.question_date ? { questionDate: q.question_date } : {}),
    };
  });
}

export function loadDataset(filePath: string): BenchQuestion[] {
  return parseDataset(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

export function ensureDataset(filePath: string = DATASET_PATH): void {
  if (fs.existsSync(filePath)) return;
  throw new Error(
    `LongMemEval-S not found at ${filePath}\n` +
      `Download it (~264 MB) first:\n` +
      `  mkdir -p "${path.dirname(filePath)}"\n` +
      `  curl -L -o "${filePath}" \\\n` +
      `    https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json\n` +
      `(If that path 404s, confirm the exact filename in the dataset's "Files" tab.)`,
  );
}
