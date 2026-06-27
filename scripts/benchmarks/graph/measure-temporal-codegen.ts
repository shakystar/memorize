// scripts/benchmarks/graph/measure-temporal-codegen.ts
//
// Track step #3: temporal / numeric reasoning (age, duration, before/after, and
// multi-quantity SUMs) — the subset the count metric does not fit. Implements the
// TReMu technique (arxiv 2502.01630, +47.8pt on its benchmark): the LLM does NOT
// compute; it writes Python over dated facts, a deterministic interpreter runs it,
// and the printed result is the answer. Compared against the raw reader answering
// from the gold sessions. Question set = the sum/temporal questions the count/sum/
// temporal classifier flagged (.bench/count-accuracy.jsonl).
//
// gpt-4o-mini for dated-fact extraction (cached); gpt-4o for codegen + match judge.
// Python executed via subprocess with a timeout; generated code is benchmark-local.
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { loadDataset, type BenchQuestion } from '../retrieval/dataset.js';

const ENDPOINT = process.env.GRAPH_LLM_ENDPOINT ?? 'https://api.openai.com/v1';
const EXTRACT_MODEL = process.env.GRAPH_LLM_MODEL ?? 'gpt-4o-mini';
const JUDGE_MODEL = process.env.GRAPH_JUDGE_MODEL ?? 'gpt-4o';
const API_KEY = process.env.GRAPH_LLM_API_KEY ?? '';
const CACHE = process.env.FACT_CACHE ?? '.bench/fact-cache';
const PYDIR = '.bench/pycode';

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

// Extract facts WITH dates (ISO if determinable from the session date), so the
// Python step has the timestamps it needs for age/duration/ordering arithmetic.
async function datedFacts(text: string, sessionDate: string | undefined): Promise<string> {
  return chat(
    EXTRACT_MODEL,
    [
      {
        role: 'user',
        content:
          `The conversation below took place on ${sessionDate ?? 'an unknown date'}. Extract every ` +
          `concrete dated fact about the user — what happened/was true and WHEN — resolving relative ` +
          `times ("last week", "3 years ago") to absolute dates where possible. Include incidental ` +
          `mentions. Return ONLY a JSON array of objects {"fact": "...", "date": "YYYY-MM-DD or null"}.` +
          `\n\n---\n${text.slice(0, 8000)}`,
      },
    ],
    'dated',
  );
}

function pyExtract(s: string): string {
  const fence = s.match(/```(?:python)?\s*([\s\S]*?)```/);
  return (fence ? fence[1]! : s).trim();
}

async function codegen(q: string, factsJson: string, qDate: string | undefined): Promise<string> {
  const out = await chat(
    JUDGE_MODEL,
    [
      {
        role: 'user',
        content:
          `Write a short Python 3 program (stdlib datetime + dateutil.relativedelta available) that ` +
          `computes the answer to the question from the dated facts and prints ONLY the answer ` +
          `(a number, or a short phrase) to stdout. Do not print anything else. Resolve dates as needed.` +
          `\n\nCurrent date: ${qDate ?? 'unknown'}\nQuestion: ${q}\n\nfacts = ${factsJson}\n\n` +
          `Output ONLY the Python code.`,
      },
    ],
    'codegen',
  );
  return pyExtract(out);
}

function runPython(code: string, id: string): string {
  fs.mkdirSync(PYDIR, { recursive: true });
  const f = path.join(PYDIR, `${id}.py`);
  fs.writeFileSync(f, code);
  const r = spawnSync('python', [f], { encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0) return `__ERR__ ${(r.stderr ?? '').trim().slice(-160)}`;
  return (r.stdout ?? '').trim().slice(0, 200);
}

async function matches(q: string, gold: string, got: string): Promise<boolean> {
  if (got.startsWith('__ERR__')) return false;
  const out = await chat(
    JUDGE_MODEL,
    [{ role: 'user', content: `Question: ${q}\nReference answer: ${gold}\nComputed answer: ${got}\n\nDo they agree on the key quantity/fact (ignore units/phrasing)? Return ONLY JSON {"match": true|false}.` }],
    'tmatch',
  );
  return /"match"\s*:\s*true/i.test(out);
}

async function rawAnswer(q: string, sessions: string, qDate: string | undefined): Promise<string> {
  return chat(
    JUDGE_MODEL,
    [{ role: 'user', content: `Answer the question from the history. Current date: ${qDate ?? 'unknown'}.\n\nHistory:\n${sessions}\n\nQuestion: ${q}\nAnswer concisely.` }],
    'rawans',
  );
}

async function main(): Promise<void> {
  if (!API_KEY) throw new Error('set GRAPH_LLM_API_KEY');
  const base = '.bench/count-accuracy.jsonl';
  if (!fs.existsSync(base)) throw new Error('run measure-count-accuracy first');
  const ckpt = '.bench/temporal-codegen.jsonl';
  const targetTypes = new Set((process.argv.includes('--types') ? process.argv[process.argv.indexOf('--types') + 1]! : 'temporal,sum').split(','));

  const all = loadDataset(path.join(process.cwd(), 'scripts/benchmarks/retrieval/data/longmemeval_s_cleaned.json'));
  const byId = new Map(all.map((q) => [q.questionId, q] as const));
  const ids = fs.readFileSync(base, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as { id: string; type: string }).filter((r) => targetTypes.has(r.type)).map((r) => r.id);

  const done = new Set<string>();
  if (fs.existsSync(ckpt)) for (const l of fs.readFileSync(ckpt, 'utf8').trim().split('\n').filter(Boolean)) done.add(JSON.parse(l).id);
  const pending = ids.filter((id) => !done.has(id));

  let i = done.size;
  const runOne = async (id: string): Promise<void> => {
    try {
      const q = byId.get(id) as BenchQuestion & { answer: string };
      const goldSessions = q.sessions.filter((s) => q.goldSessionIds.includes(s.sessionId));
      // dated facts (merge per-session JSON arrays into one list literal)
      const factObjs: unknown[] = [];
      for (const s of goldSessions) {
        const m = (await datedFacts(s.text, s.date)).match(/\[[\s\S]*\]/);
        if (m) { try { factObjs.push(...(JSON.parse(m[0]) as unknown[])); } catch { /* skip */ } }
      }
      const factsJson = JSON.stringify(factObjs).slice(0, 12000);
      const code = await codegen(q.question, factsJson, q.questionDate);
      const got = runPython(code, id);
      const codegenOk = await matches(q.question, q.answer, got);
      const raw = await rawAnswer(q.question, goldSessions.map((s) => s.text).join('\n\n').slice(0, 24000), q.questionDate);
      const rawOk = await matches(q.question, q.answer, raw);
      const rec = { id, codegenOk, rawOk, got: got.slice(0, 80), gold: q.answer.slice(0, 80) };
      fs.appendFileSync(ckpt, JSON.stringify(rec) + '\n');
      i += 1;
      process.stderr.write(`  ${i}/${ids.length} ${id} codegen=${codegenOk ? '✓' : '✗'} raw=${rawOk ? '✓' : '✗'} got="${got.slice(0, 30)}"\n`);
    } catch (err) {
      i += 1;
      process.stderr.write(`  ${i}/${ids.length} ${id} ERROR ${String(err).slice(0, 100)}\n`);
    }
  };

  let cur = 0;
  await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
    while (cur < pending.length) { const id = pending[cur++]; if (id) await runOne(id); }
  }));

  const rows = fs.readFileSync(ckpt, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { codegenOk: boolean; rawOk: boolean });
  const n = rows.length, pct = (k: number): string => `${k}/${n} (${(100 * k / n).toFixed(0)}%)`;
  console.log(`\n# temporal/numeric — n=${n} (types: ${[...targetTypes].join(',')})`);
  console.log(`raw reader:        ${pct(rows.filter((r) => r.rawOk).length)}`);
  console.log(`Python codegen:    ${pct(rows.filter((r) => r.codegenOk).length)}`);
}

await main();
