import { createHash } from 'node:crypto';

import { nowIso } from '../domain/common.js';
import { listValidMemories } from './projection-store.js';
import {
  listEmbeddings,
  upsertEmbedding,
  type EmbeddingRow,
} from './embeddings-store.js';

/**
 * P3-c — semantic search embeddings. Mirrors the LLM consolidator pattern
 * (consolidate-service.ts): a pluggable HTTP client against an OpenAI-compatible
 * `/embeddings` endpoint, configured by env, OPTIONAL. When unconfigured, every
 * helper here is a silent no-op and the system falls back to FTS5 lexical search
 * (the pre-P3-c behavior) — this is the "local fallback / works without a key"
 * guarantee. Vendor-independent: the same client talks to OpenAI, a local Ollama
 * (`http://localhost:11434/v1`), LM Studio, etc. — only the endpoint/model differ.
 */

export interface EmbeddingsConfig {
  /** Base URL of an OpenAI-compatible API exposing `/embeddings`. */
  endpoint: string;
  /** Optional — a local server (Ollama) may need none; cloud needs a key. */
  apiKey?: string;
  model: string;
  /** HTTP timeout override; tight at latency-sensitive boundaries. */
  timeoutMs?: number;
  /** Test seam; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export const DEFAULT_EMBEDDINGS_ENDPOINT = 'https://api.openai.com/v1';
export const DEFAULT_EMBEDDINGS_MODEL = 'text-embedding-3-small';
const EMBEDDINGS_TIMEOUT_MS = 20_000;

/**
 * Conservative initial char budget per embedding request. A batch whose summed
 * tokens exceed the model's context window is rejected wholesale by some servers
 * (Ollama returns HTTP 400 "the input length exceeds the context length"), so a
 * large set of inputs — a full LongMemEval haystack, a big `memory import` — is
 * packed into sub-requests of roughly this size. The exact char↔token ratio is
 * unknown per model/language, so this is only a starting point: `embedPacked`
 * adaptively halves any sub-batch the server still rejects for size.
 */
export const MAX_EMBED_BATCH_CHARS = 6_000;
/** Floor for the single-input truncation retry, so the halving loop terminates. */
export const MIN_EMBED_INPUT_CHARS = 512;

/**
 * Resolve embeddings config from env. Enabled when EITHER an endpoint OR a key
 * is set — this is a deliberate widening of the consolidator's key-only gate so
 * a keyless local server (Ollama) can be opted into with just the endpoint. Both
 * absent → undefined → semantic features off, FTS5 lexical search unchanged.
 */
export function resolveEmbeddingsConfig(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingsConfig | undefined {
  const endpoint = env.MEMORIZE_EMBEDDINGS_ENDPOINT;
  const apiKey = env.MEMORIZE_EMBEDDINGS_API_KEY;
  if (!endpoint && !apiKey) return undefined;
  return {
    endpoint: endpoint ?? DEFAULT_EMBEDDINGS_ENDPOINT,
    ...(apiKey ? { apiKey } : {}),
    model: env.MEMORIZE_EMBEDDINGS_MODEL ?? DEFAULT_EMBEDDINGS_MODEL,
  };
}

export interface Embedder {
  /** Embed a batch of texts → one vector per input, in input order. */
  embed(texts: string[]): Promise<number[][]>;
  readonly model: string;
}

export class HttpEmbedder implements Embedder {
  constructor(private readonly config: EmbeddingsConfig) {}

  get model(): string {
    return this.config.model;
  }

  /**
   * Embed any number of texts → one vector per input, in input order. Inputs are
   * greedily packed into sub-requests of ~MAX_EMBED_BATCH_CHARS; `embedPacked`
   * then adaptively halves any sub-batch the server still rejects for size, so a
   * batch whose summed tokens exceed the model context (e.g. a full LongMemEval
   * haystack, a large `memory import`) always succeeds without us needing to know
   * the exact char↔token ratio.
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    let batch: string[] = [];
    let batchChars = 0;
    for (const text of texts) {
      if (
        batch.length > 0 &&
        batchChars + text.length > MAX_EMBED_BATCH_CHARS
      ) {
        out.push(...(await this.embedPacked(batch)));
        batch = [];
        batchChars = 0;
      }
      batch.push(text);
      batchChars += text.length;
    }
    if (batch.length > 0) out.push(...(await this.embedPacked(batch)));
    return out;
  }

  /**
   * Embed one sub-batch, halving it on a size rejection (HTTP 400/413) until each
   * request fits. A single text still rejected is truncated and retried (lossy,
   * but better than dropping the memory entirely); non-size errors propagate.
   */
  private async embedPacked(texts: string[]): Promise<number[][]> {
    try {
      return await this.embedBatch(texts);
    } catch (error) {
      const status = (error as { status?: number }).status;
      const tooLarge = status === 400 || status === 413;
      if (tooLarge && texts.length > 1) {
        const mid = Math.ceil(texts.length / 2);
        const left = await this.embedPacked(texts.slice(0, mid));
        const right = await this.embedPacked(texts.slice(mid));
        return [...left, ...right];
      }
      if (
        tooLarge &&
        texts.length === 1 &&
        texts[0]!.length > MIN_EMBED_INPUT_CHARS
      ) {
        const half = Math.max(
          MIN_EMBED_INPUT_CHARS,
          Math.floor(texts[0]!.length / 2),
        );
        return this.embedPacked([texts[0]!.slice(0, half)]);
      }
      throw error;
    }
  }

  /** One HTTP request for a single sub-batch. Throws with `.status` on non-2xx. */
  private async embedBatch(texts: string[]): Promise<number[][]> {
    const fetchImpl = this.config.fetchImpl ?? fetch;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (this.config.apiKey) {
      headers.authorization = `Bearer ${this.config.apiKey}`;
    }
    const response = await fetchImpl(
      `${this.config.endpoint.replace(/\/$/, '')}/embeddings`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: this.config.model, input: texts }),
        signal: AbortSignal.timeout(
          this.config.timeoutMs ?? EMBEDDINGS_TIMEOUT_MS,
        ),
      },
    );
    if (!response.ok) {
      const error: Error & { status?: number } = new Error(
        `Embeddings HTTP ${response.status}`,
      );
      error.status = response.status;
      throw error;
    }
    const body = (await response.json()) as {
      data?: Array<{ embedding?: number[]; index?: number }>;
    };
    // OpenAI returns `data` ordered by index; sort defensively before mapping.
    const data = [...(body.data ?? [])].sort(
      (a, b) => (a.index ?? 0) - (b.index ?? 0),
    );
    return data.map((entry) => entry.embedding ?? []);
  }
}

/** Build an embedder from config (or env). Undefined when unconfigured. */
export function getEmbedder(
  config: EmbeddingsConfig | undefined = resolveEmbeddingsConfig(),
): Embedder | undefined {
  return config ? new HttpEmbedder(config) : undefined;
}

/** Stable content hash used to skip re-embedding unchanged memory text. */
export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Cosine similarity in [-1, 1]; 0 for empty/mismatched-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export const RRF_K = 60;

/**
 * Reciprocal Rank Fusion: merge several ranked id-lists (best-first) into one
 * score map, higher = better. Scale-free — combines BM25 and cosine rankings
 * without normalizing their incompatible score ranges. `score(id) = Σ 1/(k+rank)`.
 */
export function reciprocalRankFusion(
  rankedLists: string[][],
  k: number = RRF_K,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank += 1) {
      const id = list[rank]!;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    }
  }
  return scores;
}

export interface EnsureEmbeddingsResult {
  /** Memories (re-)embedded this call. 0 when off, up-to-date, or on failure. */
  embedded: number;
}

/**
 * Best-effort: embed any valid memory whose text/model lacks a current vector,
 * and upsert it. NEVER throws (the autoPush gate pattern) — an unconfigured
 * embedder, a network error, or a timeout degrades to a silent no-op, so a
 * consolidation boundary is never blocked or failed by embeddings. Called after
 * consolidation (where new memories appear); the per-call cost is bounded to the
 * stale set and only paid at boundaries.
 */
export async function ensureEmbeddings(
  projectId: string,
  opts: { embedder?: Embedder; timeoutMs?: number } = {},
): Promise<EnsureEmbeddingsResult> {
  try {
    let embedder = opts.embedder;
    if (!embedder) {
      const config = resolveEmbeddingsConfig();
      embedder = getEmbedder(
        config && opts.timeoutMs
          ? { ...config, timeoutMs: opts.timeoutMs }
          : config,
      );
    }
    if (!embedder) return { embedded: 0 };

    const memories = listValidMemories(projectId).map((row) => row.memory);
    if (memories.length === 0) return { embedded: 0 };

    const existing = new Map<string, EmbeddingRow>(
      listEmbeddings(projectId, 'memory').map((row) => [row.entityId, row]),
    );
    const stale = memories.filter((memory) => {
      const current = existing.get(memory.id);
      return (
        !current ||
        current.textHash !== hashText(memory.text) ||
        current.model !== embedder.model
      );
    });
    if (stale.length === 0) return { embedded: 0 };

    const vectors = await embedder.embed(stale.map((memory) => memory.text));
    const createdAt = nowIso();
    let embedded = 0;
    for (let i = 0; i < stale.length; i += 1) {
      const memory = stale[i]!;
      const vector = vectors[i];
      if (!vector || vector.length === 0) continue;
      upsertEmbedding(projectId, {
        entityId: memory.id,
        kind: 'memory',
        model: embedder.model,
        dim: vector.length,
        vector,
        textHash: hashText(memory.text),
        createdAt,
      });
      embedded += 1;
    }
    return { embedded };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`WARN: embeddings deferred (${message})\n`);
    return { embedded: 0 };
  }
}
