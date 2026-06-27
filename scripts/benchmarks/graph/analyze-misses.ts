// scripts/benchmarks/graph/analyze-misses.ts
//
// Per-case miss analysis: for each multi-session question, find the gold sessions
// that retrieval ranks OUTSIDE top-K, and dump WHY — the question, the missed
// gold's text (is it even on-topic? does it contain the answer?), its rank, and
// what outranked it. Aggregates over numbers hide the cause; this reads the cases.
//
// bm25 ranks are instant; pass --hybrid to also embed (OpenAI via MEMORIZE_EMBEDDINGS_*)
// and show the hybrid rank, to see which misses semantic retrieval recovers.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { loadDataset, type BenchQuestion } from '../retrieval/dataset.js';
import { retrieve } from '../retrieval/run.js';
import { seedQuestion } from '../retrieval/seed.js';
import { closeAll } from '../../../src/storage/db.js';

function snippet(text: string, n: number): string {
  return text.replace(/\s+/g, ' ').slice(0, n);
}

function selectByType(all: BenchQuestion[], types: Set<string>, perType?: number): BenchQuestion[] {
  const pool = all.filter((q) => types.has(q.questionType));
  if (!perType) return pool;
  const seen = new Map<string, number>();
  return pool.filter((q) => {
    const c = seen.get(q.questionType) ?? 0;
    if (c >= perType) return false;
    seen.set(q.questionType, c + 1);
    return true;
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (f: string): string | undefined => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const types = new Set((get('--types') ?? 'multi-session').split(','));
  const perType = get('--per-type') ? Number(get('--per-type')) : undefined;
  const K = get('--k') ? Number(get('--k')) : 20; // a gold ranked >= K (or absent) is a "miss"
  const POOL = get('--pool') ? Number(get('--pool')) : 50; // how deep to look for gold rank
  const useHybrid = argv.includes('--hybrid');

  const all = loadDataset(get('--dataset') ?? path.join(process.cwd(), 'scripts/benchmarks/retrieval/data/longmemeval_s_cleaned.json'));
  const questions = selectByType(all, types, perType);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mz-miss-'));
  process.env.MEMORIZE_ROOT = root;

  let total = 0;
  let missQuestions = 0;
  let missGold = 0;
  let hybridRecovered = 0;

  try {
    for (const q of questions) {
      const seeded = await seedQuestion(q, { rootPath: path.join(root, `proj-${q.questionId}`), embed: useHybrid });
      const bm25 = await retrieve(seeded, q.question, 'bm25', POOL);
      const hybrid = useHybrid ? await retrieve(seeded, q.question, 'hybrid', POOL) : [];
      const byId = new Map(q.sessions.map((s) => [s.sessionId, s]));
      total += 1;

      const golds = q.goldSessionIds.map((g) => ({
        sid: g,
        bm25Rank: bm25.indexOf(g),
        hybridRank: useHybrid ? hybrid.indexOf(g) : -2,
      }));
      const missed = golds.filter((g) => g.bm25Rank < 0 || g.bm25Rank >= K);
      if (missed.length === 0) continue;
      missQuestions += 1;
      missGold += missed.length;

      const lines: string[] = [];
      lines.push(`\n========== ${q.questionId} [${q.questionType}] ==========`);
      lines.push(`Q: ${snippet(q.question, 220)}`);
      lines.push(`A(gold): ${snippet(String(q.answer), 160)}`);
      lines.push(`gold ranks (bm25${useHybrid ? '/hybrid' : ''}, POOL=${POOL}): ` +
        golds.map((g) => `${g.sid.slice(0, 8)}=${g.bm25Rank}${useHybrid ? '/' + g.hybridRank : ''}`).join('  '));
      for (const g of missed) {
        if (useHybrid && g.hybridRank >= 0 && g.hybridRank < K) hybridRecovered += 1;
        const s = byId.get(g.sid);
        lines.push(`  MISSED ${g.sid.slice(0, 8)} (bm25=${g.bm25Rank}${useHybrid ? ` hybrid=${g.hybridRank}` : ''}` +
          `${useHybrid && g.hybridRank >= 0 && g.hybridRank < K ? ' <-hybrid-recovers' : ''}):`);
        lines.push(`    gold-text: ${snippet(s?.text ?? '', 400)}`);
      }
      // what outranked the gold — top-5 by bm25
      lines.push(`  top-5 bm25 retrieved (what ranked above missed gold):`);
      for (const sid of bm25.slice(0, 5)) {
        const isGold = q.goldSessionIds.includes(sid) ? ' [GOLD]' : '';
        lines.push(`    ${sid.slice(0, 8)}${isGold}: ${snippet(byId.get(sid)?.text ?? '', 160)}`);
      }
      process.stdout.write(lines.join('\n') + '\n');
    }
  } finally {
    closeAll();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }

  process.stdout.write(
    `\n\n# SUMMARY: ${missQuestions}/${total} questions miss >=1 gold at top-${K}; ${missGold} gold missed` +
      (useHybrid ? `; ${hybridRecovered} of them recovered by hybrid` : '') + '\n',
  );
}

await main();
