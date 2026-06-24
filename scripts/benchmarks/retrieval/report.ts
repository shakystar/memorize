// scripts/benchmarks/retrieval/report.ts
import type { QuestionScore } from './score.js';

export interface AggregateRow {
  label: string;
  count: number;
  recallAtK: Record<number, number>;
  mrr: number;
  ndcg10: number;
}

export interface ScoredQuestion {
  questionType: string;
  score: QuestionScore;
}

function mean(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((a, b) => a + b, 0) / values.length;
}

function rollup(
  label: string,
  rows: ScoredQuestion[],
  ks: number[],
): AggregateRow {
  const recallAtK: Record<number, number> = {};
  for (const k of ks) recallAtK[k] = mean(rows.map((r) => r.score.recallAtK[k] ?? 0));
  return {
    label,
    count: rows.length,
    recallAtK,
    mrr: mean(rows.map((r) => r.score.mrr)),
    ndcg10: mean(rows.map((r) => r.score.ndcg10)),
  };
}

export function aggregate(
  scored: ScoredQuestion[],
  ks: number[],
): { overall: AggregateRow; byType: AggregateRow[] } {
  const types = [...new Set(scored.map((s) => s.questionType))].sort();
  return {
    overall: rollup('overall', scored, ks),
    byType: types.map((t) =>
      rollup(
        t,
        scored.filter((s) => s.questionType === t),
        ks,
      ),
    ),
  };
}

export function renderTable(
  report: { overall: AggregateRow; byType: AggregateRow[] },
  ks: number[],
): string {
  const header = [
    'type',
    'n',
    ...ks.map((k) => `recall@${k}`),
    'ndcg@10',
    'mrr',
  ].join('\t');
  const fmt = (row: AggregateRow): string =>
    [
      row.label,
      String(row.count),
      ...ks.map((k) => (row.recallAtK[k] ?? 0).toFixed(4)),
      row.ndcg10.toFixed(4),
      row.mrr.toFixed(4),
    ].join('\t');
  return [header, fmt(report.overall), ...report.byType.map(fmt)].join('\n');
}
