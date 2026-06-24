// scripts/benchmarks/e2e/score-e2e.ts
export interface QuestionResult {
  questionType: string;
  isAbstention: boolean;
  correct: boolean;
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
