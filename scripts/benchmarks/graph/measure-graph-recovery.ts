// scripts/benchmarks/graph/measure-graph-recovery.ts
//
// Graph Slice-1 MECHANISM test (cheap, no LLM): does linking sessions by shared
// entities recover the multi-hop gold that BM25 ranking misses?
//
// Phase 0 showed BM25 lands the *primary* gold (any@10 ~0.98) but only gets ALL
// gold into top-10 for ~80% of multi-session questions (all@10=0.80) — the missed
// gold is the secondary-facet/multi-hop session no single query reaches. This
// measures whether a recency-independent ENTITY-LINK pull-in recovers it:
//   base       = BM25 top-K sessions
//   recovered  = base ∪ {haystack sessions sharing >= L entities with a base hit},
//                added regardless of rank, capped at maxAdd
// and reports all@K(base) vs all@K(recovered). If recovered all@10 >> 0.80 the
// graph mechanism is justified; only then is LLM entity extraction worth the cost.
//
// Entities here are a CHEAP proxy (capitalized phrases / distinctive tokens), not
// real NER — enough to test the mechanism, deliberately not the production path.
import os from 'node:os';
import path from 'node:path';

import { loadDataset, type BenchQuestion } from '../retrieval/dataset.js';
import { retrieve } from '../retrieval/run.js';
import { seedQuestion } from '../retrieval/seed.js';
import { closeAll } from '../../../src/storage/db.js';
import fs from 'node:fs';

import { extractEntitiesLLM } from './llm-entities.js';

const STOP = new Set([
  'The', 'A', 'An', 'I', 'You', 'We', 'They', 'He', 'She', 'It', 'My', 'Your',
  'This', 'That', 'These', 'Those', 'And', 'But', 'Or', 'So', 'If', 'When', 'What',
  'How', 'Why', 'Who', 'Where', 'Yes', 'No', 'Hi', 'Hello', 'Thanks', 'Thank',
  'Sure', 'Ok', 'Okay', 'Please', 'User', 'Assistant', 'Session',
]);

/** Cheap entity proxy: capitalized word(s) not at sentence start / not a stopword,
 *  plus distinctive long lowercase tokens. Noisy on purpose — tests the link
 *  mechanism, not extraction quality. */
export function extractEntities(text: string): Set<string> {
  const ents = new Set<string>();
  // Capitalized multi-word phrases (e.g. "Adobe Premiere Pro", "Sony A7R IV").
  const phrase = /\b([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = phrase.exec(text)) !== null) {
    const p = m[1]!;
    // drop single common capitalized words (likely sentence-initial)
    const words = p.split(/\s+/);
    if (words.length === 1 && STOP.has(p)) continue;
    if (words.length === 1 && p.length < 4) continue;
    ents.add(p.toLowerCase());
  }
  return ents;
}

function selectByType(all: BenchQuestion[], types: Set<string>, perType?: number): BenchQuestion[] {
  const pool = all.filter((q) => types.has(q.questionType));
  if (!perType) return pool;
  const seen = new Map<string, number>();
  return pool.filter((q) => {
    const n = seen.get(q.questionType) ?? 0;
    if (n >= perType) return false;
    seen.set(q.questionType, n + 1);
    return true;
  });
}

interface Agg {
  n: number;
  baseAll: Record<number, number>;
  recAll: Record<number, number>;
  recoveredGold: number; // gold sessions recovered that base top-maxK missed
  missingGold: number; // gold sessions base top-maxK missed
  added: number; // total sessions the recovery added (precision/budget cost)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (f: string): string | undefined => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const types = new Set((get('--types') ?? 'multi-session').split(',').map((t) => t.trim()));
  const perType = get('--per-type') ? Number(get('--per-type')) : undefined;
  const ks = (get('--k') ?? '5,10,20').split(',').map(Number);
  const maxK = Math.max(...ks);
  const maxAdd = get('--max-add') ? Number(get('--max-add')) : 10; // cap recovered sessions
  const minScore = get('--min-score') ? Number(get('--min-score')) : 1.5; // min summed-IDF to link
  const useLlm = argv.includes('--llm'); // clean LLM entities vs cheap regex proxy

  const all = loadDataset(get('--dataset') ?? path.join(process.cwd(), 'scripts/benchmarks/retrieval/data/longmemeval_s_cleaned.json'));
  const questions = selectByType(all, types, perType);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mz-graph-rec-'));
  process.env.MEMORIZE_ROOT = root;

  const byType = new Map<string, Agg>();
  const ensure = (t: string): Agg => {
    let a = byType.get(t);
    if (!a) {
      a = { n: 0, baseAll: {}, recAll: {}, recoveredGold: 0, missingGold: 0, added: 0 };
      for (const k of ks) { a.baseAll[k] = 0; a.recAll[k] = 0; }
      byType.set(t, a);
    }
    return a;
  };

  let i = 0;
  try {
    for (const q of questions) {
      const seeded = await seedQuestion(q, { rootPath: path.join(root, `proj-${q.questionId}`), embed: false });
      const ranked = await retrieve(seeded, q.question, 'bm25', maxK);
      const gold = new Set(q.goldSessionIds);

      // entity index over ALL haystack sessions (recency-independent recall pool)
      const entOf = new Map<string, Set<string>>();
      if (useLlm) {
        // Extract in chunks of concurrent API calls (cached); fall back to the
        // regex proxy for any session whose LLM extraction errors (rate-limit /
        // timeout) so one blip never drops the whole question.
        const CHUNK = 10;
        for (let j = 0; j < q.sessions.length; j += CHUNK) {
          const chunk = q.sessions.slice(j, j + CHUNK);
          const res = await Promise.all(
            chunk.map(async (s) => {
              try {
                return [s.sessionId, await extractEntitiesLLM(s.text)] as const;
              } catch {
                return [s.sessionId, extractEntities(s.text)] as const;
              }
            }),
          );
          for (const [sid, ents] of res) entOf.set(sid, ents);
        }
      } else {
        for (const s of q.sessions) entOf.set(s.sessionId, extractEntities(s.text));
      }
      // document frequency / IDF over the haystack: rare entities are discriminative;
      // common capitalized words (weekdays, "I'm") link unrelated sessions = noise.
      const df = new Map<string, number>();
      for (const s of q.sessions) for (const e of entOf.get(s.sessionId) ?? []) df.set(e, (df.get(e) ?? 0) + 1);
      const N = q.sessions.length || 1;
      const idf = (e: string): number => Math.log(N / (df.get(e) ?? N));

      // recovery: from base top-maxK sessions, pull sessions whose shared entities sum
      // enough IDF (>= minScore), ranked by summed IDF, capped at maxAdd. Rank-independent.
      const baseTop = ranked.slice(0, maxK);
      const baseSet = new Set(baseTop);
      const seedEnts = new Set<string>();
      for (const sid of baseTop) for (const e of entOf.get(sid) ?? []) seedEnts.add(e);
      const candidates: { sid: string; score: number }[] = [];
      for (const s of q.sessions) {
        if (baseSet.has(s.sessionId)) continue;
        let score = 0;
        for (const e of entOf.get(s.sessionId) ?? []) if (seedEnts.has(e)) score += idf(e);
        if (score >= minScore) candidates.push({ sid: s.sessionId, score });
      }
      candidates.sort((a, b) => b.score - a.score);
      const recovered = candidates.slice(0, maxAdd).map((c) => c.sid);
      const recoveredSet = new Set([...baseTop, ...recovered]);

      const a = ensure(q.questionType);
      a.n += 1;
      a.added += recovered.length;
      for (const k of ks) {
        const inBaseK = q.goldSessionIds.filter((g) => ranked.slice(0, k).includes(g)).length;
        a.baseAll[k]! += inBaseK === gold.size ? 1 : 0;
        // recovered set = top-k ∪ recovered (recovered are rank-independent)
        const recK = new Set([...ranked.slice(0, k), ...recovered]);
        const inRecK = q.goldSessionIds.filter((g) => recK.has(g)).length;
        a.recAll[k]! += inRecK === gold.size ? 1 : 0;
      }
      // gold the base top-maxK missed, and how many the recovery brought back
      for (const g of q.goldSessionIds) {
        if (!baseSet.has(g)) {
          a.missingGold += 1;
          if (recoveredSet.has(g)) a.recoveredGold += 1;
        }
      }
      i += 1;
      if (i % 20 === 0) process.stderr.write(`  ${i}/${questions.length}\n`);
    }
  } finally {
    closeAll();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }

  console.log(`# graph-recovery mechanism (IDF-weighted entity proxy) minScore=${minScore} maxAdd=${maxAdd} maxK=${maxK}`);
  console.log(`# base = BM25 top-K; rec = top-K ∪ entity-linked (rank-independent); avgAdd = sessions added/q (budget cost)`);
  const head = ['type', 'n', ...ks.flatMap((k) => [`base_all@${k}`, `rec_all@${k}`]), 'avgAdd', 'recovGold'];
  console.log(head.join('\t'));
  for (const [t, a] of byType) {
    const cells = [
      t, String(a.n),
      ...ks.flatMap((k) => [(a.baseAll[k]! / a.n).toFixed(2), (a.recAll[k]! / a.n).toFixed(2)]),
      (a.added / a.n).toFixed(1),
      `${a.recoveredGold}/${a.missingGold}`,
    ];
    console.log(cells.join('\t'));
  }
}

await main();
