// scripts/benchmarks/e2e/run-e2e-benchmark.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveEmbeddingsConfig } from '../../../src/services/embeddings-service.js';
import { listValidMemories } from '../../../src/services/projection-store.js';
import { closeAll } from '../../../src/storage/db.js';

import { loadDataset, type BenchQuestion, type BenchSession } from '../retrieval/dataset.js';
import { retrieve, type Mode } from '../retrieval/run.js';
import { seedQuestion } from '../retrieval/seed.js';

import { seedQuestionConsolidated } from './consolidate-seed.js';

import { appendCheckpoint, loadCheckpoint, type CheckpointRecord } from './checkpoint.js';
import { resolveChat, type Chat } from './chat-client.js';
import { judge } from './judge.js';
import { answer, selectForBudget } from './reader.js';
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
  /** Take the first N questions of EACH type (stratified, deterministic) so a
   *  small eval set covers the weak categories. Takes precedence over `sample`. */
  perType?: number;
  /** Restrict to these question types (e.g. ['multi-session']). Lets a run target
   *  one weak category as its own non-overlapping batch. Empty/undefined = all. */
  types?: string[];
  /** Skip the first N questions of each type before applying perType — carves a
   *  large category into non-overlapping slices (batch 1 = offset 0, batch 2 =
   *  offset N, …) so sequential/parallel batches never re-score the same question. */
  typeOffset?: number;
  /** ORACLE ablation: bypass retrieval AND consolidation entirely and feed the
   *  reader the question's gold sessions directly. Isolates the reader: if a weak
   *  category jumps to single-session accuracy under oracle, the bottleneck is
   *  retrieval recall (build the graph); if it stays low, it is reader aggregation
   *  (reflection). ~1.5 min/q (no 14-min consolidation). */
  oracle?: boolean;
  /** Max questions processed concurrently. Oracle is I/O-bound on the reader/judge
   *  LLMs, so a pool of ~4 cuts wall-clock ~4× under one safe concurrency cap.
   *  Default 1 (sequential). */
  concurrency?: number;
  /** Consolidation ON: route each session through the product `consolidate()`
   *  (distilled memories are what retrieval sees) instead of the bypass seed
   *  (one memory per raw session). Requires extractorCwd + transcriptDir. */
  consolidate?: boolean;
  /** Project-free cwd for the consolidation extractor (consolidate mode). */
  extractorCwd?: string;
  /** Where per-session JSONL transcripts are written (consolidate mode). */
  transcriptDir?: string;
  /** When set, each scored question is appended here as JSONL and a restart
   *  resumes from it (skipping already-scored questionIds). Must live outside
   *  the temp MEMORIZE_ROOT, which is deleted at the end of a run. */
  checkpointPath?: string;
  /** Per-question progress sink (X/total + running accuracy). Defaults to a
   *  no-op so the smoke test and library callers stay silent. */
  progress?: (message: string) => void;
}

/** Run weak/interesting categories first so a partial run surfaces them early
 *  (consolidation is ~14 min/question); single-session-* last. Unlisted types
 *  fall after these, before nothing. */
const TYPE_RUN_ORDER = [
  'multi-session',
  'temporal-reasoning',
  'knowledge-update',
  'single-session-preference',
  'single-session-user',
  'single-session-assistant',
];

/** Deterministic question selection: stratified (first N per question_type) when
 *  perType is set, else a head-slice of `sample`, else all. LongMemEval-S is
 *  sorted in type blocks, so a plain head-slice is all single-session-user;
 *  stratified is the only way a small set covers the weak categories. Result is
 *  ordered by TYPE_RUN_ORDER (weak categories first). */
export function selectQuestions(
  all: BenchQuestion[],
  opts: { perType?: number; sample?: number; types?: string[]; typeOffset?: number },
): BenchQuestion[] {
  // Category filter first, so perType/offset count within the targeted types.
  const typeSet = opts.types && opts.types.length > 0 ? new Set(opts.types) : undefined;
  const pool = typeSet ? all.filter((q) => typeSet.has(q.questionType)) : all;

  let picked: BenchQuestion[];
  if (opts.perType || opts.typeOffset) {
    const offset = opts.typeOffset ?? 0;
    const seen = new Map<string, number>();
    picked = pool.filter((q) => {
      const n = seen.get(q.questionType) ?? 0;
      seen.set(q.questionType, n + 1);
      // Keep indices [offset, offset + perType) per type; perType unset = no upper bound.
      if (n < offset) return false;
      if (opts.perType && n >= offset + opts.perType) return false;
      return true;
    });
  } else {
    picked = opts.sample ? pool.slice(0, opts.sample) : pool;
  }
  const prio = (t: string): number => {
    const i = TYPE_RUN_ORDER.indexOf(t);
    return i < 0 ? TYPE_RUN_ORDER.length : i;
  };
  // Stable sort keeps within-type order; only reorders across types.
  return [...picked].sort((a, b) => prio(a.questionType) - prio(b.questionType));
}

export async function runE2E(opts: E2EOptions): Promise<E2EReport> {
  const all = loadDataset(opts.datasetPath);
  const questions = selectQuestions(all, opts);
  const log = opts.progress ?? (() => {});

  // Non-string gold answers are unscoreable; count them once and never seed,
  // retrieve, or checkpoint them.
  const answerable = questions.filter(
    (q): q is BenchQuestion & { answer: string } => q.answer !== null,
  );
  const skipped = questions.length - answerable.length;
  const total = answerable.length;

  const done = opts.checkpointPath
    ? loadCheckpoint(opts.checkpointPath)
    : new Map<string, CheckpointRecord>();
  const results: QuestionResult[] = [];
  // Resumed results feed both the running accuracy and the final aggregate.
  for (const rec of done.values()) {
    results.push({ questionType: rec.questionType, isAbstention: rec.isAbstention, correct: rec.correct });
  }
  let processed = results.length;
  if (done.size > 0) log(`resumed ${done.size} completed question(s) from ${opts.checkpointPath}`);

  const pending = answerable.filter((q) => !done.has(q.questionId));

  const runOne = async (q: BenchQuestion & { answer: string }): Promise<void> => {
    try {
      const goldSet = new Set(q.goldSessionIds);
      const byId = new Map(q.sessions.map((s) => [s.sessionId, s]));

      let topSessions: BenchSession[];
      let goldRank = -1;
      let goldInTopK: number;
      let memoryCount = 0;

      if (opts.oracle) {
        // ORACLE: bypass retrieval + consolidation, hand the reader the gold
        // sessions directly. Isolates whether the reader can answer with perfect
        // recall (aggregation-bound) or not (then nothing upstream can help).
        topSessions = q.sessions.filter((s) => goldSet.has(s.sessionId));
        goldInTopK = topSessions.length;
      } else {
        const projRoot = path.join(opts.rootPath, `proj-${q.questionId}`);
        const seeded = opts.consolidate
          ? await seedQuestionConsolidated(q, {
              rootPath: projRoot,
              transcriptDir: path.join(opts.transcriptDir!, q.questionId),
              extractorCwd: opts.extractorCwd!,
            })
          : await seedQuestion(q, { rootPath: projRoot, embed: opts.retrieval === 'hybrid' });
        const rankedSessionIds = await retrieve(seeded, q.question, opts.retrieval, opts.k);
        const goldRanks = q.goldSessionIds
          .map((g) => rankedSessionIds.indexOf(g))
          .filter((i) => i >= 0);
        goldRank = goldRanks.length > 0 ? Math.min(...goldRanks) : -1;
        memoryCount = listValidMemories(seeded.projectId).length;
        topSessions = rankedSessionIds
          .map((id) => byId.get(id))
          .filter((s): s is NonNullable<typeof s> => Boolean(s));
        goldInTopK = topSessions.filter((s) => goldSet.has(s.sessionId)).length;
      }

      // How many gold sessions survived the reader char-budget — reuse the reader's
      // own selection (selectForBudget) so the count is exact, not a re-derivation.
      const inBudget = new Set(
        selectForBudget(topSessions, q.questionDate).map((s) => s.session.sessionId),
      );
      const goldInBudget = q.goldSessionIds.filter((g) => inBudget.has(g)).length;

      const candidate = await answer(opts.reader, q.question, topSessions, q.questionDate);
      const correct = await judge(opts.judge, {
        question: q.question,
        gold: q.answer,
        answer: candidate,
        isAbstention: q.isAbstention,
        questionType: q.questionType,
      });
      const result: QuestionResult = {
        questionType: q.questionType,
        isAbstention: q.isAbstention,
        correct,
        mode: opts.oracle ? 'oracle' : 'real',
        // Bottleneck-localization diagnostics: gold coverage at each stage
        // (top-K → budget) splits recall-bound from aggregation-bound failures.
        goldRetrieved: goldInTopK > 0,
        goldRank,
        memoryCount,
        goldTotal: q.goldSessionIds.length,
        goldInTopK,
        goldInBudget,
        answer: candidate.slice(0, 400),
        gold: q.answer,
      };
      results.push(result);
      if (opts.checkpointPath) {
        appendCheckpoint(opts.checkpointPath, { questionId: q.questionId, ...result });
      }
      processed += 1;
      const hits = results.filter((r) => r.correct).length;
      log(
        `[${processed}/${total}] ${q.questionType} ${q.questionId} correct=${correct} ` +
          `gold ${goldInBudget}/${goldInTopK}/${q.goldSessionIds.length} (budget/topK/total) ` +
          `| acc ${(hits / results.length).toFixed(4)} (${hits}/${results.length})`,
      );
    } catch (err) {
      // A single reader/judge/seed failure (e.g. a claude -p throttle blip) must
      // skip this question, never abort the whole batch (overnight robustness).
      processed += 1;
      log(
        `[${processed}/${total}] ${q.questionType} ${q.questionId} ERROR ` +
          `${String(err).slice(0, 160)} — skipped`,
      );
    }
  };

  // Concurrency pool: up to N questions in flight. JS is single-threaded so the
  // shared results array / checkpoint appends are race-free between awaits.
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
      while (cursor < pending.length) {
        const next = pending[cursor++];
        if (!next) break;
        await runOne(next);
      }
    }),
  );

  return { ...aggregate(results), skipped };
}

function parseArgs(argv: string[]): {
  retrieval: Mode;
  k: number;
  sample?: number;
  perType?: number;
  types?: string[];
  typeOffset?: number;
  oracle?: boolean;
  concurrency?: number;
  consolidate?: boolean;
  out?: string;
  checkpoint?: string;
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
  const perTypeRaw = get('--per-type');
  if (perTypeRaw !== undefined && (!Number.isInteger(Number(perTypeRaw)) || Number(perTypeRaw) <= 0)) {
    throw new Error('--per-type must be a positive integer');
  }
  const typeOffsetRaw = get('--type-offset');
  if (typeOffsetRaw !== undefined && (!Number.isInteger(Number(typeOffsetRaw)) || Number(typeOffsetRaw) < 0)) {
    throw new Error('--type-offset must be a non-negative integer');
  }
  const typesRaw = get('--types');
  const types = typesRaw
    ? typesRaw.split(',').map((t) => t.trim()).filter(Boolean)
    : undefined;
  const concurrencyRaw = get('--concurrency');
  if (concurrencyRaw !== undefined && (!Number.isInteger(Number(concurrencyRaw)) || Number(concurrencyRaw) <= 0)) {
    throw new Error('--concurrency must be a positive integer');
  }
  const datasetPath =
    get('--dataset') ??
    path.join(process.cwd(), 'scripts/benchmarks/retrieval/data/longmemeval_s_cleaned.json');
  return {
    retrieval,
    k,
    ...(sampleRaw ? { sample: Number(sampleRaw) } : {}),
    ...(perTypeRaw ? { perType: Number(perTypeRaw) } : {}),
    ...(types ? { types } : {}),
    ...(typeOffsetRaw ? { typeOffset: Number(typeOffsetRaw) } : {}),
    ...(argv.includes('--oracle') ? { oracle: true } : {}),
    ...(concurrencyRaw ? { concurrency: Number(concurrencyRaw) } : {}),
    ...(argv.includes('--consolidate') ? { consolidate: true } : {}),
    ...(get('--out') ? { out: get('--out')! } : {}),
    ...(get('--checkpoint') ? { checkpoint: get('--checkpoint')! } : {}),
    datasetPath,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  // Oracle bypasses retrieval entirely, so it needs no embedder.
  if (!args.oracle && args.retrieval === 'hybrid' && !resolveEmbeddingsConfig()) {
    throw new Error(
      'hybrid retrieval requires an embedder. Set MEMORIZE_EMBEDDINGS_ENDPOINT ' +
        '(e.g. http://localhost:11434/v1) and MEMORIZE_EMBEDDINGS_MODEL (e.g. bge-m3).',
    );
  }
  const reader = resolveChat('reader');
  const judgeChat = resolveChat('judge');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mz-e2e-'));
  // consolidation ON: extractor runs in a project-free cwd, and per-session
  // transcripts live outside MEMORIZE_ROOT (which is wiped at the end).
  const extractorCwd = args.consolidate
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'mz-e2e-ecwd-'))
    : undefined;
  const transcriptDir = args.consolidate
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'mz-e2e-tx-'))
    : undefined;
  process.env.MEMORIZE_ROOT = root;
  if (args.oracle)
    console.log(
      `# ORACLE ablation: retrieval+consolidation bypassed, gold sessions fed directly` +
        `${args.concurrency ? ` (concurrency ${args.concurrency})` : ''}`,
    );
  else if (args.consolidate) console.log('# consolidation: ON (product pipeline, project-free extractor cwd)');
  try {
    const report = await runE2E({
      datasetPath: args.datasetPath,
      retrieval: args.retrieval,
      k: args.k,
      rootPath: root,
      reader,
      judge: judgeChat,
      ...(args.sample ? { sample: args.sample } : {}),
      ...(args.perType ? { perType: args.perType } : {}),
      ...(args.types ? { types: args.types } : {}),
      ...(args.typeOffset ? { typeOffset: args.typeOffset } : {}),
      ...(args.oracle ? { oracle: true } : {}),
      ...(args.concurrency ? { concurrency: args.concurrency } : {}),
      ...(args.consolidate ? { consolidate: true, extractorCwd: extractorCwd!, transcriptDir: transcriptDir! } : {}),
      ...(args.checkpoint ? { checkpointPath: args.checkpoint } : {}),
      progress: (message) => process.stderr.write(`${message}\n`),
    });
    console.log(renderTable(report));
    if (args.out) {
      fs.writeFileSync(args.out, JSON.stringify(report, null, 2));
      console.log(`\nwrote ${args.out}`);
    }
  } finally {
    closeAll();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    if (extractorCwd) fs.rmSync(extractorCwd, { recursive: true, force: true, maxRetries: 3 });
    if (transcriptDir) fs.rmSync(transcriptDir, { recursive: true, force: true, maxRetries: 3 });
  }
}
