// scripts/benchmarks/retrieval/dataset.ts
import fs from 'node:fs';
import path from 'node:path';

export interface BenchSession {
  sessionId: string;
  text: string;
}

export interface BenchQuestion {
  questionId: string;
  question: string;
  questionType: string;
  sessions: BenchSession[];
  goldSessionIds: string[];
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
  haystack_session_ids?: string[];
  haystack_sessions?: RawTurn[][];
  answer_session_ids?: string[];
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
      !q.question_id ||
      !q.question ||
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
    return {
      questionId: q.question_id,
      question: q.question,
      questionType: q.question_type ?? 'unknown',
      sessions: ids.map((sessionId, j) => ({
        sessionId,
        text: flattenSession(sessions[j] ?? []),
      })),
      goldSessionIds: q.answer_session_ids,
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
