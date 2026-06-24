// scripts/benchmarks/e2e/run-e2e-benchmark.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveEmbeddingsConfig } from '../../../src/services/embeddings-service.js';
import { closeAll } from '../../../src/storage/db.js';

import { loadDataset } from '../retrieval/dataset.js';
import { retrieve, type Mode } from '../retrieval/run.js';
import { seedQuestion } from '../retrieval/seed.js';

import { resolveChat, type Chat } from './chat-client.js';
import { judge } from './judge.js';
import { answer } from './reader.js';
import { renderTable, type E2EReport } from './report-e2e.js';
import { aggregate, type QuestionResult } from './score-e2e.js';

export interface E2EOptions {
  datasetPath: string;
  retrieval: Mode;
  k: number;
  rootPath: string;
  reader: Chat;
  judge: Chat;
  sample?: number;
}

export async function runE2E(opts: E2EOptions): Promise<E2EReport> {
  const all = loadDataset(opts.datasetPath);
  const questions = opts.sample ? all.slice(0, opts.sample) : all;
  const results: QuestionResult[] = [];
  let skipped = 0;

  for (const q of questions) {
    if (q.answer === null) {
      skipped += 1;
      continue;
    }
    const seeded = await seedQuestion(q, {
      rootPath: path.join(opts.rootPath, `proj-${q.questionId}`),
      embed: opts.retrieval === 'hybrid',
    });
    const rankedSessionIds = await retrieve(seeded, q.question, opts.retrieval, opts.k);
    const byId = new Map(q.sessions.map((s) => [s.sessionId, s]));
    const topSessions = rankedSessionIds
      .map((id) => byId.get(id))
      .filter((s): s is NonNullable<typeof s> => Boolean(s));
    const candidate = await answer(opts.reader, q.question, topSessions);
    const correct = await judge(opts.judge, {
      question: q.question,
      gold: q.answer,
      answer: candidate,
      isAbstention: q.isAbstention,
    });
    results.push({ questionType: q.questionType, isAbstention: q.isAbstention, correct });
  }

  return { ...aggregate(results), skipped };
}

function parseArgs(argv: string[]): {
  retrieval: Mode;
  k: number;
  sample?: number;
  out?: string;
  datasetPath: string;
} {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const retrieval = (get('--retrieval') ?? 'hybrid') as Mode;
  if (retrieval !== 'bm25' && retrieval !== 'hybrid') {
    throw new Error('--retrieval must be bm25 or hybrid');
  }
  const kRaw = get('--k');
  const k = kRaw ? Number(kRaw) : 5;
  if (!Number.isInteger(k) || k <= 0) throw new Error('--k must be a positive integer');
  const sampleRaw = get('--sample');
  if (sampleRaw !== undefined && (!Number.isInteger(Number(sampleRaw)) || Number(sampleRaw) <= 0)) {
    throw new Error('--sample must be a positive integer');
  }
  const datasetPath =
    get('--dataset') ??
    path.join(process.cwd(), 'scripts/benchmarks/retrieval/data/longmemeval_s_cleaned.json');
  return {
    retrieval,
    k,
    ...(sampleRaw ? { sample: Number(sampleRaw) } : {}),
    ...(get('--out') ? { out: get('--out')! } : {}),
    datasetPath,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  if (args.retrieval === 'hybrid' && !resolveEmbeddingsConfig()) {
    throw new Error(
      'hybrid retrieval requires an embedder. Set MEMORIZE_EMBEDDINGS_ENDPOINT ' +
        '(e.g. http://localhost:11434/v1) and MEMORIZE_EMBEDDINGS_MODEL (e.g. bge-m3).',
    );
  }
  const reader = resolveChat('reader');
  const judgeChat = resolveChat('judge');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mz-e2e-'));
  process.env.MEMORIZE_ROOT = root;
  try {
    const report = await runE2E({
      datasetPath: args.datasetPath,
      retrieval: args.retrieval,
      k: args.k,
      rootPath: root,
      reader,
      judge: judgeChat,
      ...(args.sample ? { sample: args.sample } : {}),
    });
    console.log(renderTable(report));
    if (args.out) {
      fs.writeFileSync(args.out, JSON.stringify(report, null, 2));
      console.log(`\nwrote ${args.out}`);
    }
  } finally {
    closeAll();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
