// scripts/benchmarks/retrieval/score.ts

export interface QuestionScore {
  /** K -> 1 if any gold appears in top-K, else 0. */
  recallAtK: Record<number, number>;
  mrr: number;
  ndcg10: number;
}

export function recallAnyAtK(
  ranked: string[],
  gold: Set<string>,
  k: number,
): number {
  return ranked.slice(0, k).some((id) => gold.has(id)) ? 1 : 0;
}

export function mrr(ranked: string[], gold: Set<string>): number {
  for (let i = 0; i < ranked.length; i += 1) {
    if (gold.has(ranked[i]!)) return 1 / (i + 1);
  }
  return 0;
}

export function ndcgAtK(ranked: string[], gold: Set<string>, k: number): number {
  let dcg = 0;
  const top = Math.min(k, ranked.length);
  for (let i = 0; i < top; i += 1) {
    if (gold.has(ranked[i]!)) dcg += 1 / Math.log2(i + 2);
  }
  const idealHits = Math.min(gold.size, k);
  let idcg = 0;
  for (let i = 0; i < idealHits; i += 1) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

export function scoreQuestion(
  ranked: string[],
  goldSessionIds: string[],
  ks: number[],
): QuestionScore {
  const gold = new Set(goldSessionIds);
  const recallAtK: Record<number, number> = {};
  for (const k of ks) recallAtK[k] = recallAnyAtK(ranked, gold, k);
  return { recallAtK, mrr: mrr(ranked, gold), ndcg10: ndcgAtK(ranked, gold, 10) };
}
