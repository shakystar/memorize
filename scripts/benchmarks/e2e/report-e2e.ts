// scripts/benchmarks/e2e/report-e2e.ts
import type { AccuracyRow } from './score-e2e.js';

export interface E2EReport {
  overall: AccuracyRow;
  byType: AccuracyRow[];
  abstention: AccuracyRow;
  skipped: number;
}

export function renderTable(report: E2EReport): string {
  const fmt = (r: AccuracyRow): string =>
    [r.label, String(r.n), r.n === 0 ? '-' : r.accuracy.toFixed(4)].join('\t');
  return [
    'type\tn\taccuracy',
    fmt(report.overall),
    ...report.byType.map(fmt),
    fmt(report.abstention),
    `(skipped ${report.skipped} questions with non-string gold answers)`,
  ].join('\n');
}
