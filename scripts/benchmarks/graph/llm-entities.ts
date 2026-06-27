// scripts/benchmarks/graph/llm-entities.ts
//
// LLM entity extraction for the graph-recovery precision test. The cheap
// capitalized-phrase proxy hit a precision floor (too many spurious high-IDF
// matches — no threshold prunes them), so we extract CLEAN canonical entities.
// Local model (Ollama) by default so iteration is free/fast; content-hash cached
// to a sidecar so re-runs and A/Bs are instant. This is a benchmark probe, not
// the product extractor (which is consolidate-service's claude -p path).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ENDPOINT = process.env.GRAPH_LLM_ENDPOINT ?? 'http://localhost:11434/v1';
const MODEL = process.env.GRAPH_LLM_MODEL ?? 'llama3.2:3b';
const CACHE_DIR = process.env.GRAPH_ENT_CACHE ?? '.bench/ent-cache';

const PROMPT =
  'Extract the DISTINCTIVE named entities from the conversation below — specific ' +
  'people, pets, products/models, brands, places, organizations, projects, and ' +
  'named items the user refers to. Use short canonical names (e.g. "Sony A7R IV", ' +
  '"Max", "Premiere Pro"). Skip generic words. Return ONLY a JSON array of ' +
  'strings, nothing else.';

function cachePath(text: string): string {
  const hash = crypto.createHash('sha1').update(`${MODEL}\n${text}`).digest('hex');
  return path.join(CACHE_DIR, `${hash}.json`);
}

/** Best-effort parse of a JSON array of strings from a model reply (handles code
 *  fences / leading prose by grabbing the first [...] block). */
export function parseEntityArray(reply: string): string[] {
  const m = reply.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is string => typeof x === 'string')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 1 && s.length < 60);
  } catch {
    return [];
  }
}

export async function extractEntitiesLLM(
  text: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<Set<string>> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cp = cachePath(text);
  if (fs.existsSync(cp)) {
    try {
      return new Set(JSON.parse(fs.readFileSync(cp, 'utf8')) as string[]);
    } catch {
      /* fall through to recompute */
    }
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  // Entities cluster early/throughout; truncating the input keeps CPU extraction
  // tractable (~25s/session at 17k chars → ~10s at 6k) with little entity loss.
  const maxChars = Number(process.env.GRAPH_ENT_CHARS ?? 6_000);
  const body = {
    model: MODEL,
    temperature: 0,
    messages: [{ role: 'user', content: `${PROMPT}\n\n---\n${text.slice(0, maxChars)}` }],
  };
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const apiKey = process.env.GRAPH_LLM_API_KEY;
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetchImpl(`${ENDPOINT.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
  });
  if (!res.ok) throw new Error(`entity LLM HTTP ${res.status}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const ents = parseEntityArray(json.choices?.[0]?.message?.content ?? '');
  fs.writeFileSync(cp, JSON.stringify(ents));
  return new Set(ents);
}
