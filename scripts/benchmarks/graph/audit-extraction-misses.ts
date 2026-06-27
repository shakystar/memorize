// scripts/benchmarks/graph/audit-extraction-misses.ts
//
// Audit the residual ~0.09 of the #1 extraction-recall gate: for the pure-count
// questions where completeness+counter extraction STILL undercounts, name WHICH
// instance was missed and show the facts, so we can characterize the failure
// (e.g. extremely terse mention, pronoun/coref, split across a session boundary,
// or genuinely absent from the gold session). Reuses the cached extractions.
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
  'have, experienced, plan to do, or own — INCLUDING anything mentioned only in passing, as an ' +
  'aside, or as a "by the way". Do not omit minor or incidental details; prioritize completeness ' +
  'over conciseness. Return ONLY a JSON array of short atomic fact strings.';
const COUNTER =
  'List every distinct person, place, organization, event, activity, purchase, or item the user ' +
  'mentions interacting with or experiencing in this conversation — even if mentioned only briefly ' +
  'or in passing. Return ONLY a JSON array of short strings.';

async function complete(text: string): Promise<string[]> {
  const [a, b] = await Promise.all([
    chat(EXTRACT_MODEL, [{ role: 'user', content: `${COMPLETE}\n\n---\n${text.slice(0, 8000)}` }], 'cmpl'),
    chat(EXTRACT_MODEL, [{ role: 'user', content: `${COUNTER}\n\n---\n${text.slice(0, 8000)}` }], 'cntr'),
  ]);
  return [...new Set([...parseArr(a), ...parseArr(b)])];
}

async function main(): Promise<void> {
  if (!API_KEY) throw new Error('set GRAPH_LLM_API_KEY');
  const rows = fs
    .readFileSync('.bench/extract-recall.jsonl', 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as { id: string; n: number; complCovered: number });
  const unit = /hours?|days?|minutes?|weeks?|months?|years?|\$|dollar|miles?|km|kg|pounds?/i;
  const all = loadDataset(path.join(process.cwd(), 'scripts/benchmarks/retrieval/data/longmemeval_s_cleaned.json'));
  const byId = new Map(all.map((q) => [q.questionId, q] as const));

  const misses = rows.filter((r) => {
    const q = byId.get(r.id) as (BenchQuestion & { answer: string }) | undefined;
    return q && r.complCovered < r.n && !r.id.endsWith('_abs') && !unit.test(q.answer) && r.n <= 10;
  });

  for (const r of misses) {
    const q = byId.get(r.id) as BenchQuestion & { answer: string };
    const facts: string[] = [];
    for (const s of q.sessions.filter((s) => q.goldSessionIds.includes(s.sessionId))) facts.push(...(await complete(s.text)));
    const out = await chat(
      JUDGE_MODEL,
      [
        {
          role: 'user',
          content:
            `Question: ${q.question}\nReference answer (lists the ${r.n} required items): ${q.answer}\n\n` +
            `Extracted facts:\n${facts.map((f) => `- ${f}`).join('\n')}\n\n` +
            `Which of the ${r.n} required items are NOT clearly supported by the facts? For each missing ` +
            `item, give a 6-word reason it was missed (e.g. "mentioned only as vague aside"). ` +
            `Return ONLY JSON: {"missing": [{"item": "...", "reason": "..."}]}.`,
        },
      ],
      'miss',
    );
    const m = out.match(/\{[\s\S]*\}/);
    const parsed = m ? (JSON.parse(m[0]) as { missing?: { item: string; reason: string }[] }) : { missing: [] };
    console.log(`\n## ${r.id}  N=${r.n} covered=${r.complCovered}  facts=${facts.length}`);
    console.log(`Q: ${q.question.slice(0, 140)}`);
    console.log(`A: ${q.answer.slice(0, 160)}`);
    for (const mi of parsed.missing ?? []) console.log(`  MISSED: ${mi.item}  — ${mi.reason}`);
  }
}

await main();
