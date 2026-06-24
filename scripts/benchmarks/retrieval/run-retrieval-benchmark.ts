// scripts/benchmarks/retrieval/run-retrieval-benchmark.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { closeAll } from '../../../src/storage/db.js';
import { resolveEmbeddingsConfig } from '../../../src/services/embeddings-service.js';

import { DATASET_PATH, ensureDataset, loadDataset } from './dataset.js';
import { aggregate, renderTable, type AggregateRow } from './report.js';
import { retrieve, type Mode } from './run.js';
import { scoreQuestion } from './score.js';
import { seedQuestion } from './seed.js';

export interface RunOptions {
  mode: Mode;
  datasetPath: string;
  ks: number[];
  rootPath: string;
  sample?: number;
}

export async function runBenchmark(
  opts: RunOptions,
): Promise<{ overall: AggregateRow; byType: AggregateRow[] }> {
  const all = loadDataset(opts.datasetPath);
  const questions = opts.sample ? all.slice(0, opts.sample) : all;
  const maxK = Math.max(...opts.ks);
  const embed = opts.mode === 'hybrid';

  const scored = [];
  for (const q of questions) {
    const seeded = await seedQuestion(q, {
      rootPath: path.join(opts.rootPath, `proj-${q.questionId}`),
      embed,
    });
    const ranked = await retrieve(seeded, q.question, opts.mode, maxK);
    scored.push({
      questionType: q.questionType,
      score: scoreQuestion(ranked, q.goldSessionIds, opts.ks),
    });
  }
  return aggregate(scored, opts.ks);
}

function parseArgs(argv: string[]): {
  mode: Mode;
  sample?: number;
  ks: number[];
  out?: string;
  datasetPath: string;
} {
  const mode = argv[0] as Mode;
  if (mode !== 'bm25' && mode !== 'hybrid') {
    throw new Error('usage: run-retrieval-benchmark <bm25|hybrid> [--sample N] [--k 5,10,20] [--out file] [--dataset path]');
  }
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const sampleRaw = get('--sample');
  const ksRaw = get('--k');
  const ks = ksRaw ? ksRaw.split(',').map(Number) : [5, 10, 20];
  if (ks.some((k) => !Number.isInteger(k) || k <= 0)) {
    throw new Error('--k must be positive integers, e.g. --k 5,10,20');
  }
  if (sampleRaw !== undefined && (!Number.isInteger(Number(sampleRaw)) || Number(sampleRaw) <= 0)) {
    throw new Error('--sample must be a positive integer');
  }
  return {
    mode,
    ...(sampleRaw ? { sample: Number(sampleRaw) } : {}),
    ks,
    ...(get('--out') ? { out: get('--out')! } : {}),
    datasetPath: get('--dataset') ?? DATASET_PATH,
  };
}

// Entry point (only when run directly, not when imported by the smoke test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'hybrid' && !resolveEmbeddingsConfig()) {
    throw new Error(
      'hybrid mode requires an embedder. Set MEMORIZE_EMBEDDINGS_ENDPOINT ' +
        '(e.g. http://localhost:11434/v1) and MEMORIZE_EMBEDDINGS_MODEL (e.g. bge-m3). ' +
        'Without it hybridSearch silently degrades to bm25.',
    );
  }
  if (args.datasetPath === DATASET_PATH) ensureDataset(DATASET_PATH);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mz-bench-retrieval-'));
  process.env.MEMORIZE_ROOT = root;
  try {
    const report = await runBenchmark({
      mode: args.mode,
      datasetPath: args.datasetPath,
      ks: args.ks,
      rootPath: root,
      ...(args.sample ? { sample: args.sample } : {}),
    });
    console.log(renderTable(report, args.ks));
    if (args.out) {
      fs.writeFileSync(args.out, JSON.stringify(report, null, 2));
      console.log(`\nwrote ${args.out}`);
    }
  } finally {
    closeAll(); // release SQLite handles before rmSync (Windows EBUSY; full run opens ~500 projects)
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
