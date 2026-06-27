// scripts/benchmarks/graph/measure-extraction-recall.ts
//
// Track step #1 GATE (hardened): does completeness-first + counter-extraction
// capture the scattered/incidental instances that counting/aggregation questions
// need? Counting needs ~1.0 recall (miss one instance -> wrong count).
//
// Hardened vs v1: a STRONG judge (gpt-4o) first fixes the GROUND TRUTH from the
// gold answer — the target count N and the enumerated instances — instead of
// inventing "total" per call. Then it scores how many of those N instances each
// extraction variant's facts cover. Extraction is gpt-4o-mini (the thing under
// test). All prompts domain-neutral; the gold answer's own enumeration is ground
// truth, never a hardcoded category list. Content-hash cached; per-question JSONL
// dump for hand-validation of the judge.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { loadDataset, type BenchQuestion } from '../retrieval/dataset.js';

const ENDPOINT = process.env.GRAPH_LLM_ENDPOINT ?? 'https://api.openai.com/v1';
const EXTRACT_MODEL = process.env.GRAPH_LLM_MODEL ?? 'gpt-4o-mini';
const JUDGE_MODEL = process.env.GRAPH_JUDGE_MODEL ?? 'gpt-4o';
const API_KEY = process.env.GRAPH_LLM_API_KEY ?? '';
const CACHE = process.env.FACT_CACHE ?? '.bench/fact-cache';

async function chat(model: string, messages: { role: string; content: string }[], tag: string): Promise<string> {
  fs.mkdirSync(CACHE, { recursive: true });
  const key = crypto.createHash('sha1').update(model + tag + JSON.stringify(messages)).digest('hex');
  const cp = path.join(CACHE, `${key}.txt`);
  if (fs.existsSync(cp)) return fs.readFileSync(cp, 'utf8');
  // Retry on 429 (rate limit) / 5xx with exponential backoff + jitter.
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(`${ENDPOINT.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model, temperature: 0, messages }),
      signal: AbortSignal.timeout(90_000),
    });
    if (res.ok) {
      const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const out = j.choices?.[0]?.message?.content ?? '';
      fs.writeFileSync(cp, out);
      return out;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 7) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt + Math.floor(Math.random() * 500)));
      continue;
    }
    throw new Error(`chat HTTP ${res.status} (${model})`);
  }
}

function parseArr(s: string): string[] {
  const m = s.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const a = JSON.parse(m[0]) as unknown;
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function parseObj(s: string): Record<string, unknown> {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return {};
  try {
    return JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const BASELINE_PROMPT =
  'Extract the key facts about the user from this conversation. Return ONLY a JSON array of short fact strings.';
const COMPLETE_PROMPT =
  'From the conversation below, extract EVERY concrete fact about the user — everything they ' +
  'did, have, experienced, plan to do, or own — INCLUDING anything mentioned only in passing, ' +
  'as an aside, or as a "by the way". Do not omit minor or incidental details; prioritize ' +
  'completeness over conciseness. Return ONLY a JSON array of short atomic fact strings.';
const COUNTER_PROMPT =
  'List every distinct person, place, organization, event, activity, purchase, or item the user ' +
  'mentions interacting with or experiencing in this conversation — even if mentioned only ' +
  'briefly or in passing. Return ONLY a JSON array of short strings.';

const extractBaseline = async (t: string): Promise<string[]> =>
  parseArr(await chat(EXTRACT_MODEL, [{ role: 'user', content: `${BASELINE_PROMPT}\n\n---\n${t.slice(0, 8000)}` }], 'base'));
async function extractComplete(t: string): Promise<string[]> {
  const [a, b] = await Promise.all([
    chat(EXTRACT_MODEL, [{ role: 'user', content: `${COMPLETE_PROMPT}\n\n---\n${t.slice(0, 8000)}` }], 'cmpl'),
    chat(EXTRACT_MODEL, [{ role: 'user', content: `${COUNTER_PROMPT}\n\n---\n${t.slice(0, 8000)}` }], 'cntr'),
  ]);
  return [...new Set([...parseArr(a), ...parseArr(b)])];
}

async function groundTruth(q: string, gold: string): Promise<{ n: number; instances: string[] }> {
  const out = await chat(
    JUDGE_MODEL,
    [
      {
        role: 'user',
        content:
          `This is a counting/aggregation question with a reference answer. Determine the exact ` +
          `target the answer requires: the number N of distinct items/events that must be found, ` +
          `and (if the answer enumerates them) the list of those items.\n\n` +
          `Question: ${q}\nReference answer: ${gold}\n\n` +
          `Return ONLY JSON: {"n": <integer>, "instances": [<short labels, or [] if not enumerated>]}.`,
      },
    ],
    'gt',
  );
  const o = parseObj(out);
  return { n: Math.max(1, Number(o.n ?? 1)), instances: parseArr(JSON.stringify(o.instances ?? [])) };
}

async function coverage(q: string, gt: { n: number; instances: string[] }, facts: string[]): Promise<number> {
  const out = await chat(
    JUDGE_MODEL,
    [
      {
        role: 'user',
        content:
          `We must answer: "${q}". The correct answer requires finding ${gt.n} distinct items/events` +
          (gt.instances.length ? `, specifically: ${gt.instances.join('; ')}.` : '.') +
          `\n\nHere are facts extracted from the user's history:\n` +
          facts.map((f) => `- ${f}`).join('\n') +
          `\n\nHow many of the ${gt.n} required items are clearly supported by these facts? ` +
          `${gt.instances.length ? 'Check each listed item.' : 'Count distinct qualifying items present, capped at N.'} ` +
          `Return ONLY JSON: {"covered": <int 0..${gt.n}>}.`,
      },
    ],
    'cov',
  );
  return Math.min(gt.n, Math.max(0, Number(parseObj(out).covered ?? 0)));
}

async function main(): Promise<void> {
  if (!API_KEY) throw new Error('set GRAPH_LLM_API_KEY');
  const argv = process.argv.slice(2);
  const get = (f: string): string | undefined => (argv.indexOf(f) >= 0 ? argv[argv.indexOf(f) + 1] : undefined);
  const limit = get('--limit') ? Number(get('--limit')) : 1000;
  const conc = get('--concurrency') ? Number(get('--concurrency')) : 6;
  const ckpt = get('--checkpoint') ?? '.bench/extract-recall.jsonl';
  const agg = /how many|how much|how old|how long|how often|total number|number of/i;

  const all = loadDataset(path.join(process.cwd(), 'scripts/benchmarks/retrieval/data/longmemeval_s_cleaned.json'));
  const qs = all
    .filter((x): x is BenchQuestion & { answer: string } =>
      x.questionType === 'multi-session' && typeof x.answer === 'string' && agg.test(x.question))
    .slice(0, limit);

  const done = new Set<string>();
  if (fs.existsSync(ckpt)) for (const l of fs.readFileSync(ckpt, 'utf8').trim().split('\n').filter(Boolean)) done.add(JSON.parse(l).id);
  const pending = qs.filter((q) => !done.has(q.questionId));

  let i = done.size;
  const runOne = async (q: BenchQuestion & { answer: string }): Promise<void> => {
    try {
      const goldSessions = q.sessions.filter((s) => q.goldSessionIds.includes(s.sessionId));
      const baseFacts: string[] = [];
      const complFacts: string[] = [];
      for (const s of goldSessions) {
        const [bf, cf] = await Promise.all([extractBaseline(s.text), extractComplete(s.text)]);
        baseFacts.push(...bf);
        complFacts.push(...cf);
      }
      const gt = await groundTruth(q.question, q.answer);
      const [baseCov, complCov] = await Promise.all([
        coverage(q.question, gt, baseFacts),
        coverage(q.question, gt, complFacts),
      ]);
      const rec = {
        id: q.questionId, n: gt.n, baseCovered: baseCov, complCovered: complCov,
        baseFull: baseCov >= gt.n, complFull: complCov >= gt.n,
        answer: q.answer.slice(0, 120), nBaseFacts: baseFacts.length, nComplFacts: complFacts.length,
      };
      fs.appendFileSync(ckpt, JSON.stringify(rec) + '\n');
      i += 1;
      process.stderr.write(`  ${i}/${qs.length} ${q.questionId} N=${gt.n} base=${baseCov} compl=${complCov}\n`);
    } catch (err) {
      i += 1;
      process.stderr.write(`  ${i}/${qs.length} ${q.questionId} ERROR ${String(err).slice(0, 120)}\n`);
    }
  };

  let cur = 0;
  await Promise.all(
    Array.from({ length: Math.min(conc, pending.length) }, async () => {
      while (cur < pending.length) {
        const q = pending[cur++];
        if (q) await runOne(q);
      }
    }),
  );

  // aggregate from checkpoint
  const rows = fs.readFileSync(ckpt, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as {
    n: number; baseCovered: number; complCovered: number; baseFull: boolean; complFull: boolean;
  });
  const mean = (f: (r: (typeof rows)[number]) => number): number => rows.reduce((a, r) => a + f(r), 0) / rows.length;
  console.log(`\n# extraction-recall gate (hardened) — n=${rows.length} aggregative multi-session questions`);
  console.log(`# coverage = covered/N (N = instances the gold answer requires); full = covered>=N (count would be right)`);
  console.log(`baseline (salience)       mean coverage = ${mean((r) => r.baseCovered / r.n).toFixed(3)}   full-cover = ${rows.filter((r) => r.baseFull).length}/${rows.length}`);
  console.log(`complete + counter-pass   mean coverage = ${mean((r) => r.complCovered / r.n).toFixed(3)}   full-cover = ${rows.filter((r) => r.complFull).length}/${rows.length}`);
}

await main();
