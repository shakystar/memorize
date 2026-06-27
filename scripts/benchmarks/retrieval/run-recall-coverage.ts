// scripts/benchmarks/retrieval/run-recall-coverage.ts
//
// Free retrieval-recall localization (no reader, no judge, no consolidation).
// Bypass-seeds each question's raw sessions, retrieves, and reports per-type GOLD
// COVERAGE at several K — the faithful multi-session measure that `recallAnyAtK`
// (any-gold@K) misses: a multi-session answer needs ALL its gold sessions, so we
// report mean fraction of gold in top-K, plus any@K and all@K. Run bm25 vs hybrid
// on the SAME set to read off the embedding contribution.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveEmbeddingsConfig } from '../../../src/services/embeddings-service.js';
import { closeAll } from '../../../src/storage/db.js';

import { DATASET_PATH, ensureDataset, loadDataset, type BenchQuestion } from './dataset.js';
import { retrieve, type Mode } from './run.js';
import { seedQuestion } from './seed.js';

interface CoverageRow {
  questionType: string;
  goldTotal: number;
  /** fraction of this question's gold sessions present in top-K, per K */
  fracInK: Record<number, number>;
  /** 1 if ALL gold in top-K, per K */
  allInK: Record<number, number>;
  /** 1 if ANY gold in top-K, per K */
  anyInK: Record<number, number>;
}

function selectByType(
  all: BenchQuestion[],
  types: string[] | undefined,
  perType: number | undefined,
): BenchQuestion[] {
  const typeSet = types && types.length > 0 ? new Set(types) : undefined;
  const pool = typeSet ? all.filter((q) => typeSet.has(q.questionType)) : all;
  if (!perType) return pool;
  const seen = new Map<string, number>();
  return pool.filter((q) => {
    const n = seen.get(q.questionType) ?? 0;
    if (n >= perType) return false;
    seen.set(q.questionType, n + 1);
    return true;
  });
}

export async function runCoverage(opts: {
  mode: Mode;
  ks: number[];
  rootPath: string;
  datasetPath: string;
  types?: string[];
  perType?: number;
  /** Append each question's coverage as a JSONL row as it completes, so a long
   *  CPU-embedded hybrid run is observable mid-flight (early-stop once the
   *  bm25-vs-hybrid verdict on the discriminating category is clear). */
  checkpointPath?: string;
  progress?: (m: string) => void;
}): Promise<CoverageRow[]> {
  const all = loadDataset(opts.datasetPath);
  const questions = selectByType(all, opts.types, opts.perType);
  const maxK = Math.max(...opts.ks);
  const embed = opts.mode === 'hybrid';
  const log = opts.progress ?? (() => {});

  const rows: CoverageRow[] = [];
  let i = 0;
  for (const q of questions) {
    const seeded = await seedQuestion(q, {
      rootPath: path.join(opts.rootPath, `proj-${q.questionId}`),
      embed,
    });
    const ranked = await retrieve(seeded, q.question, opts.mode, maxK);
    const gold = q.goldSessionIds;
    const ranksOfGold = gold.map((g) => ranked.indexOf(g));
    const fracInK: Record<number, number> = {};
    const allInK: Record<number, number> = {};
    const anyInK: Record<number, number> = {};
    for (const k of opts.ks) {
      const inK = ranksOfGold.filter((r) => r >= 0 && r < k).length;
      fracInK[k] = gold.length > 0 ? inK / gold.length : 0;
      allInK[k] = inK === gold.length ? 1 : 0;
      anyInK[k] = inK > 0 ? 1 : 0;
    }
    const rowRec = { questionType: q.questionType, goldTotal: gold.length, fracInK, allInK, anyInK };
    rows.push(rowRec);
    if (opts.checkpointPath) fs.appendFileSync(opts.checkpointPath, `${JSON.stringify(rowRec)}\n`);
    i += 1;
    log(`  ${i}/${questions.length} ${q.questionType}`);
  }
  return rows;
}

function aggregateByType(rows: CoverageRow[], ks: number[]): string {
  const types = [...new Set(rows.map((r) => r.questionType))];
  const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const head = ['type', 'n', 'goldAvg', ...ks.flatMap((k) => [`cov@${k}`, `all@${k}`, `any@${k}`])];
  const lines = [head.join('\t')];
  for (const t of ['multi-session', 'temporal-reasoning', 'knowledge-update', ...types].filter(
    (t, idx, a) => a.indexOf(t) === idx && types.includes(t),
  )) {
    const rs = rows.filter((r) => r.questionType === t);
    const cells = [
      t,
      String(rs.length),
      mean(rs.map((r) => r.goldTotal)).toFixed(1),
      ...ks.flatMap((k) => [
        mean(rs.map((r) => r.fracInK[k]!)).toFixed(2),
        mean(rs.map((r) => r.allInK[k]!)).toFixed(2),
        mean(rs.map((r) => r.anyInK[k]!)).toFixed(2),
      ]),
    ];
    lines.push(cells.join('\t'));
  }
  return lines.join('\n');
}

function parseArgs(argv: string[]): {
  mode: Mode;
  ks: number[];
  types?: string[];
  perType?: number;
  checkpoint?: string;
  out?: string;
  datasetPath: string;
} {
  const mode = argv[0] as Mode;
  if (mode !== 'bm25' && mode !== 'hybrid') {
    throw new Error('usage: run-recall-coverage <bm25|hybrid> [--types a,b] [--per-type N] [--k 5,10,20] [--out f]');
  }
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const ksRaw = get('--k');
  const ks = ksRaw ? ksRaw.split(',').map(Number) : [5, 10, 20];
  if (ks.some((k) => !Number.isInteger(k) || k <= 0)) throw new Error('--k must be positive integers');
  const typesRaw = get('--types');
  const types = typesRaw ? typesRaw.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
  const perTypeRaw = get('--per-type');
  if (perTypeRaw !== undefined && (!Number.isInteger(Number(perTypeRaw)) || Number(perTypeRaw) <= 0)) {
    throw new Error('--per-type must be a positive integer');
  }
  return {
    mode,
    ks,
    ...(types ? { types } : {}),
    ...(perTypeRaw ? { perType: Number(perTypeRaw) } : {}),
    ...(get('--checkpoint') ? { checkpoint: get('--checkpoint')! } : {}),
    ...(get('--out') ? { out: get('--out')! } : {}),
    datasetPath: get('--dataset') ?? DATASET_PATH,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'hybrid' && !resolveEmbeddingsConfig()) {
    throw new Error(
      'hybrid requires an embedder (MEMORIZE_EMBEDDINGS_ENDPOINT + _MODEL); else it silently degrades to bm25.',
    );
  }
  if (args.datasetPath === DATASET_PATH) ensureDataset(DATASET_PATH);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mz-recall-cov-'));
  process.env.MEMORIZE_ROOT = root;
  try {
    const rows = await runCoverage({
      mode: args.mode,
      ks: args.ks,
      rootPath: root,
      datasetPath: args.datasetPath,
      ...(args.types ? { types: args.types } : {}),
      ...(args.perType ? { perType: args.perType } : {}),
      ...(args.checkpoint ? { checkpointPath: args.checkpoint } : {}),
      progress: (m) => process.stderr.write(`${m}\n`),
    });
    console.log(`# mode=${args.mode} types=${args.types?.join(',') ?? 'all'} perType=${args.perType ?? 'all'} n=${rows.length}`);
    console.log('# cov@K = mean fraction of gold in top-K; all@K = frac with ALL gold; any@K = frac with >=1');
    console.log(aggregateByType(rows, args.ks));
    if (args.out) {
      fs.writeFileSync(args.out, JSON.stringify(rows, null, 2));
      console.log(`\nwrote ${args.out}`);
    }
  } finally {
    closeAll();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
