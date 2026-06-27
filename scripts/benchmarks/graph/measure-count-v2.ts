// scripts/benchmarks/graph/measure-count-v2.ts
//
// Track step #2 v2: STRUCTURED counting. #2 v1 showed naive "how many?" over the
// high-recall/low-precision fact dump OVER-counts. The structured approach forces
// the count to be deterministic over an explicitly filtered + deduplicated set:
//   1. filter: keep only facts that match the thing being counted
//   2. dedup + enumerate: list the DISTINCT instances (same item once)
//   3. count = length of that list (deterministic)
// Enumerating named instances is much harder to inflate than a free-form "how
// many?", and the filter removes the counter-pass noise. Compared 3-way against
// raw-session counting and naive fact-counting (from .bench/count-accuracy.jsonl).
// Domain-neutral; the LLM filters by the question's own terms, never benchmark
// category names. gpt-4o-mini extraction (cached), gpt-4o for filter/dedup.
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
    throw new Error(`chat HTTP ${res.status}`);
  }
}
const parseArr = (s: string): string[] => {
  const m = s.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const a = JSON.parse(m[0]) as unknown;
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

const COMPLETE =
  'From the conversation below, extract EVERY concrete fact about the user — everything they did, ' +
  'have, experienced, plan to do, or own — INCLUDING anything mentioned only in passing or as a ' +
  '"by the way". Prioritize completeness over conciseness. Return ONLY a JSON array of short fact strings.';
const COUNTER =
  'List every distinct person, place, organization, event, activity, purchase, or item the user ' +
  'mentions interacting with or experiencing — even if only in passing. Return ONLY a JSON array of strings.';

async function completeFacts(text: string): Promise<string[]> {
  const [a, b] = await Promise.all([
    chat(EXTRACT_MODEL, [{ role: 'user', content: `${COMPLETE}\n\n---\n${text.slice(0, 8000)}` }], 'cmpl'),
    chat(EXTRACT_MODEL, [{ role: 'user', content: `${COUNTER}\n\n---\n${text.slice(0, 8000)}` }], 'cntr'),
  ]);
  return [...new Set([...parseArr(a), ...parseArr(b)])];
}

// Structured count: filter to matching facts, then enumerate DISTINCT instances.
async function structuredCount(q: string, facts: string[]): Promise<number> {
  const out = await chat(
    JUDGE_MODEL,
    [
      {
        role: 'user',
        content:
          `Question: ${q}\n\nFacts extracted from the user's history:\n` +
          facts.map((f) => `- ${f}`).join('\n') +
          `\n\nList ONLY the DISTINCT items that this question counts, based strictly on the facts. ` +
          `Rules: include an item only if a fact clearly supports it; merge duplicates (the same item ` +
          `mentioned in multiple facts counts ONCE); exclude items that don't match the question. ` +
          `Return ONLY a JSON array of the distinct item labels. The answer count is the array length.`,
      },
    ],
    'structcnt',
  );
  return parseArr(out).length;
}

async function main(): Promise<void> {
  if (!API_KEY) throw new Error('set GRAPH_LLM_API_KEY');
  const base = '.bench/count-accuracy.jsonl';
  if (!fs.existsSync(base)) throw new Error(`run measure-count-accuracy first (${base} missing)`);
  const ckpt = '.bench/count-v2.jsonl';

  const all = loadDataset(path.join(process.cwd(), 'scripts/benchmarks/retrieval/data/longmemeval_s_cleaned.json'));
  const byId = new Map(all.map((q) => [q.questionId, q] as const));
  const baseRows = fs.readFileSync(base, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as { id: string; type: string; n?: number; rawOk?: boolean; factOk?: boolean });
  const counts = baseRows.filter((r) => r.type === 'count' && typeof r.n === 'number');

  const done = new Set<string>();
  if (fs.existsSync(ckpt)) for (const l of fs.readFileSync(ckpt, 'utf8').trim().split('\n').filter(Boolean)) done.add(JSON.parse(l).id);
  const pending = counts.filter((r) => !done.has(r.id));

  let i = done.size;
  const runOne = async (r: { id: string; n?: number; rawOk?: boolean; factOk?: boolean }): Promise<void> => {
    try {
      const q = byId.get(r.id) as BenchQuestion & { answer: string };
      const facts: string[] = [];
      for (const s of q.sessions.filter((s) => q.goldSessionIds.includes(s.sessionId))) facts.push(...(await completeFacts(s.text)));
      const sc = await structuredCount(q.question, facts);
      const rec = { id: r.id, n: r.n, structCount: sc, structOk: sc === r.n, rawOk: !!r.rawOk, factOk: !!r.factOk };
      fs.appendFileSync(ckpt, JSON.stringify(rec) + '\n');
      i += 1;
      process.stderr.write(`  ${i}/${counts.length} ${r.id} n=${r.n} struct=${sc} (raw${r.rawOk ? '✓' : '✗'} naive${r.factOk ? '✓' : '✗'})\n`);
    } catch (err) {
      i += 1;
      process.stderr.write(`  ${i}/${counts.length} ${r.id} ERROR ${String(err).slice(0, 100)}\n`);
    }
  };

  let cur = 0;
  await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
    while (cur < pending.length) { const r = pending[cur++]; if (r) await runOne(r); }
  }));

  const rows = fs.readFileSync(ckpt, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { rawOk: boolean; factOk: boolean; structOk: boolean });
  const n = rows.length, pct = (k: number): string => `${k}/${n} (${(100 * k / n).toFixed(0)}%)`;
  console.log(`\n# count accuracy 3-way — pure-count n=${n}`);
  console.log(`raw-session count:   ${pct(rows.filter((r) => r.rawOk).length)}`);
  console.log(`naive fact count:    ${pct(rows.filter((r) => r.factOk).length)}`);
  console.log(`STRUCTURED count:    ${pct(rows.filter((r) => r.structOk).length)}`);
}

await main();
