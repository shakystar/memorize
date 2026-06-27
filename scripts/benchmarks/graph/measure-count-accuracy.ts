// scripts/benchmarks/graph/measure-count-accuracy.ts
//
// Track step #2: does deterministic-ish counting over EXTRACTED FACTS beat the
// reader counting over RAW text? #1 showed extraction preserves the instances
// (0.91 coverage); #2 asks whether structuring them into facts then yields the
// correct count N — the actual goal.
//
// First a domain-neutral classifier splits aggregative questions into pure-count
// vs sum vs temporal vs other (the audit showed the regex filter let sums/temporal
// leak in). On PURE-COUNT only, compare two counters against the gold count N:
//   raw   = count from the concatenated gold sessions (what the reader does today)
//   facts = count from the completeness+counter extracted facts
// All gpt-4o-mini extraction (cached); gpt-4o for classify/count/ground-truth.
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
const parseInt0 = (s: string): number => {
  const m = s.match(/-?\d+(\.\d+)?/);
  return m ? Math.round(Number(m[0])) : -999;
};

const COMPLETE =
  'From the conversation below, extract EVERY concrete fact about the user — everything they did, ' +
  'have, experienced, plan to do, or own — INCLUDING anything mentioned only in passing or as a ' +
  '"by the way". Prioritize completeness over conciseness. Return ONLY a JSON array of short fact strings.';
const COUNTER =
  'List every distinct person, place, organization, event, activity, purchase, or item the user ' +
  'mentions interacting with or experiencing — even if only in passing. Return ONLY a JSON array of strings.';

async function complete(text: string): Promise<string[]> {
  const [a, b] = await Promise.all([
    chat(EXTRACT_MODEL, [{ role: 'user', content: `${COMPLETE}\n\n---\n${text.slice(0, 8000)}` }], 'cmpl'),
    chat(EXTRACT_MODEL, [{ role: 'user', content: `${COUNTER}\n\n---\n${text.slice(0, 8000)}` }], 'cntr'),
  ]);
  return [...new Set([...parseArr(a), ...parseArr(b)])];
}

async function classify(q: string, answer: string): Promise<string> {
  const out = await chat(
    JUDGE_MODEL,
    [
      {
        role: 'user',
        content:
          `Classify this aggregative question by what arithmetic the answer needs:\n` +
          `- "count": count distinct items/events of one kind (e.g. how many doctors visited)\n` +
          `- "sum": add up two or more different quantities or amounts (e.g. goals AND assists; total money/hours)\n` +
          `- "temporal": date/age/duration arithmetic (e.g. how many years older, how long since)\n` +
          `- "other": anything else\n\n` +
          `Question: ${q}\nAnswer: ${answer}\n\nReturn ONLY JSON: {"type": "count|sum|temporal|other"}.`,
      },
    ],
    'cls',
  );
  const m = out.match(/"type"\s*:\s*"(\w+)"/);
  return m ? m[1]! : 'other';
}

async function groundTruthN(q: string, gold: string): Promise<number> {
  const out = await chat(
    JUDGE_MODEL,
    [{ role: 'user', content: `Counting question. From the reference answer, give the exact integer count it states/implies.\nQuestion: ${q}\nAnswer: ${gold}\nReturn ONLY JSON: {"n": <integer>}.` }],
    'gtn',
  );
  return parseInt0(out);
}

const countPrompt = (q: string, body: string): { role: string; content: string }[] => [
  {
    role: 'user',
    content:
      `Answer this counting question by counting the DISTINCT relevant items present below. ` +
      `Count carefully; do not double-count the same item mentioned twice.\n\n` +
      `Question: ${q}\n\n${body}\n\nReturn ONLY JSON: {"count": <integer>}.`,
  },
];

async function main(): Promise<void> {
  if (!API_KEY) throw new Error('set GRAPH_LLM_API_KEY');
  const argv = process.argv.slice(2);
  const get = (f: string): string | undefined => (argv.indexOf(f) >= 0 ? argv[argv.indexOf(f) + 1] : undefined);
  const limit = get('--limit') ? Number(get('--limit')) : 1000;
  const ckpt = get('--checkpoint') ?? '.bench/count-accuracy.jsonl';
  const agg = /how many|how much|how old|how long|how often|total number|number of/i;

  const all = loadDataset(path.join(process.cwd(), 'scripts/benchmarks/retrieval/data/longmemeval_s_cleaned.json'));
  const qs = all
    .filter((x): x is BenchQuestion & { answer: string } =>
      x.questionType === 'multi-session' && typeof x.answer === 'string' && !x.questionId.endsWith('_abs') && agg.test(x.question))
    .slice(0, limit);

  const done = new Set<string>();
  if (fs.existsSync(ckpt)) for (const l of fs.readFileSync(ckpt, 'utf8').trim().split('\n').filter(Boolean)) done.add(JSON.parse(l).id);

  let i = 0;
  const runOne = async (q: BenchQuestion & { answer: string }): Promise<void> => {
    try {
      const type = await classify(q.question, q.answer);
      const rec: Record<string, unknown> = { id: q.questionId, type };
      if (type === 'count') {
        const n = await groundTruthN(q.question, q.answer);
        const goldSessions = q.sessions.filter((s) => q.goldSessionIds.includes(s.sessionId));
        const facts: string[] = [];
        for (const s of goldSessions) facts.push(...(await complete(s.text)));
        const raw = goldSessions.map((s) => s.text).join('\n\n').slice(0, 24000);
        const [cRaw, cFacts] = await Promise.all([
          chat(JUDGE_MODEL, countPrompt(q.question, `History:\n${raw}`), 'cntraw'),
          chat(JUDGE_MODEL, countPrompt(q.question, `Known facts:\n${facts.map((f) => `- ${f}`).join('\n')}`), 'cntfact'),
        ]);
        Object.assign(rec, { n, rawCount: parseInt0(cRaw), factCount: parseInt0(cFacts), rawOk: parseInt0(cRaw) === n, factOk: parseInt0(cFacts) === n });
      }
      fs.appendFileSync(ckpt, JSON.stringify(rec) + '\n');
      i += 1;
      process.stderr.write(`  ${i}/${qs.length} ${q.questionId} type=${type}${type === 'count' ? ` n=${rec.n} raw=${rec.rawCount} fact=${rec.factCount}` : ''}\n`);
    } catch (err) {
      i += 1;
      process.stderr.write(`  ${i}/${qs.length} ${q.questionId} ERROR ${String(err).slice(0, 100)}\n`);
    }
  };

  const pending = qs.filter((q) => !done.has(q.questionId));
  let cur = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, pending.length) }, async () => {
      while (cur < pending.length) {
        const q = pending[cur++];
        if (q) await runOne(q);
      }
    }),
  );

  const rows = fs.readFileSync(ckpt, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const counts = rows.filter((r) => r.type === 'count');
  const types = rows.reduce<Record<string, number>>((a, r) => ((a[r.type as string] = (a[r.type as string] ?? 0) + 1), a), {});
  console.log(`\n# count-accuracy — types: ${JSON.stringify(types)}`);
  console.log(`# pure-count n=${counts.length}`);
  console.log(`count from RAW sessions:   ${counts.filter((r) => r.rawOk).length}/${counts.length} correct`);
  console.log(`count from EXTRACTED facts: ${counts.filter((r) => r.factOk).length}/${counts.length} correct`);
}

await main();
