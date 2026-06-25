// scripts/benchmarks/e2e/score-e2e.ts
export interface QuestionResult {
  questionType: string;
  isAbstention: boolean;
  correct: boolean;
  /** Failure-analysis diagnostics (optional; populated by the run, ignored by
   *  aggregate). Lets a false be classified: retrieval miss (gold not in top-K
   *  → consolidation dropped/weakened the needle) vs reader miss (gold present
   *  but the answer is wrong). */
  goldRetrieved?: boolean;
  /** Best (lowest) retrieval rank of any gold session, 0-based; -1 if none in
   *  top-K. Distinguishes "gold ranked low" from "gold high but reader-truncated". */
  goldRank?: number;
  /** Valid memories after seeding (consolidation distill count). */
  memoryCount?: number;
  /** Reader answer (truncated) and gold, for eyeballing reader misses. */
  answer?: string;
  gold?: string | null;
}

export interface AccuracyRow {
  label: string;
  n: number;
  accuracy: number;
}

function row(label: string, rows: QuestionResult[]): AccuracyRow {
  return {
    label,
    n: rows.length,
    accuracy:
      rows.length === 0 ? 0 : rows.filter((r) => r.correct).length / rows.length,
  };
}

export function aggregate(results: QuestionResult[]): {
  overall: AccuracyRow;
  byType: AccuracyRow[];
  abstention: AccuracyRow;
} {
  const types = [...new Set(results.map((r) => r.questionType))].sort();
  return {
    overall: row('overall', results),
    byType: types.map((t) => row(t, results.filter((r) => r.questionType === t))),
    abstention: row('abstention', results.filter((r) => r.isAbstention)),
  };
}
