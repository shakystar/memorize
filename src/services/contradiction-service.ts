import { createConflict } from '../domain/entities/conflict.js';
import type { MemorySupersededPayload } from '../domain/entities/memory.js';
import type { DomainEventPayload } from '../domain/events.js';
import type { MemoryRecord } from '../projections/projector.js';
import {
  type AppendEventInput,
  appendEvents,
} from '../storage/event-store.js';
import {
  resolveLlmConfig,
  type LlmConsolidatorConfig,
} from './consolidate-service.js';
import {
  cosineSimilarity,
  getEmbedder,
  type Embedder,
} from './embeddings-service.js';
import { listEmbeddings } from './embeddings-store.js';
import {
  listValidMemories,
  rebuildProjectProjection,
} from './projection-store.js';

/**
 * P3-c 2라운드 — semantic contradiction detection (direction decision ⑤).
 *
 * Finds pairs of valid `decision` memories that an embedding says are about the
 * SAME topic (high cosine) and an LLM judge confirms assert INCOMPATIBLE facts
 * ("DB = SQLite" vs "DB = Postgres"). For each confirmed contradiction it keeps
 * the MORE RECENT decision as the current truth and supersedes the older one
 * (non-destructive invalidate — the event/row survives for point-in-time
 * replay), and emits a `conflict.detected` so the agent sees the fork and can
 * resolve it with a fresh decision.
 *
 * Runs at the consolidation boundary, best-effort and NEVER-throwing (the
 * autoPush/ensureEmbeddings gate pattern). Requires BOTH an embedder AND an LLM
 * — embeddings alone cannot tell "agree" from "disagree" (both cluster), and the
 * factual-incompatibility judgment is the LLM's job. With neither configured it
 * is a silent no-op.
 *
 * Determinism: winner = greater `(createdAt, id)` tuple, a pure function of
 * immutable event fields, so every replica converges to the SAME current truth
 * after sync (no split-brain). When the two sides come from different sessions
 * (likely a concurrent, sync-delayed fork rather than a causal supersession) the
 * conflict is tagged `concurrent` as a hint; precise causality is HLC (#39).
 *
 * Idempotency: a superseded loser leaves the valid set, so the same pair never
 * re-forms on a later pass — no duplicate conflicts, no re-supersede.
 */

export interface JudgePair {
  aId: string;
  aText: string;
  bId: string;
  bText: string;
}

export interface JudgeVerdict {
  aId: string;
  bId: string;
  contradicts: boolean;
  /** Short topic label for the conflict (e.g. "database engine"). */
  topic?: string;
}

/** Judge a batch of same-topic candidate pairs. Injectable for tests. */
export type Judge = (pairs: JudgePair[]) => Promise<JudgeVerdict[]>;

export interface DetectContradictionsOptions {
  actor: string;
  sessionId?: string;
  /** Defaults to getEmbedder() (env). No embedder → no-op. */
  embedder?: Embedder;
  /** Defaults to an LLM judge from resolveLlmConfig(). No judge → no-op. */
  judge?: Judge;
  /** Min cosine similarity for a pair to be a contradiction candidate. */
  threshold?: number;
  /** Cap on candidate pairs sent to the judge (cost bound). */
  maxPairs?: number;
}

export interface DetectContradictionsResult {
  detected: number;
}

const DEFAULT_THRESHOLD = 0.82;
const DEFAULT_MAX_PAIRS = 20;
const JUDGE_TIMEOUT_MS = 15_000;

const JUDGE_SYSTEM_PROMPT = [
  'You are a contradiction judge for a coding-agent memory system.',
  'Each input item has two decision statements (a, b) already known to be',
  'topically similar. Decide whether they assert INCOMPATIBLE facts about the',
  'SAME thing (e.g. "DB is SQLite" vs "DB is Postgres") — a real contradiction,',
  'NOT merely related or elaborating. Return ONLY a JSON array of',
  '{"i":number,"contradicts":boolean,"topic":string} — one per input item, `i`',
  'echoing the input index, `topic` a 1-4 word label. No prose.',
].join(' ');

/** Order a pair oldest-first by (createdAt, id). Returns [loser, winner]. */
function orderByRecency(
  a: MemoryRecord,
  b: MemoryRecord,
): [MemoryRecord, MemoryRecord] {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? [a, b] : [b, a];
  }
  return a.id < b.id ? [a, b] : [b, a];
}

function parseJudgeReply(
  content: string,
): Array<{ i: number; contradicts: boolean; topic?: string }> {
  const start = content.indexOf('[');
  const end = content.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(content.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: Array<{ i: number; contradicts: boolean; topic?: string }> = [];
  for (const entry of raw) {
    if (entry && typeof entry === 'object') {
      const obj = entry as { i?: unknown; contradicts?: unknown; topic?: unknown };
      if (typeof obj.i === 'number' && typeof obj.contradicts === 'boolean') {
        out.push({
          i: obj.i,
          contradicts: obj.contradicts,
          ...(typeof obj.topic === 'string' ? { topic: obj.topic } : {}),
        });
      }
    }
  }
  return out;
}

/** Build an LLM-backed judge from config (or env). Undefined when unconfigured. */
export function makeLlmJudge(
  config: LlmConsolidatorConfig | undefined = resolveLlmConfig(),
): Judge | undefined {
  if (!config) return undefined;
  return async (pairs: JudgePair[]): Promise<JudgeVerdict[]> => {
    const fetchImpl = config.fetchImpl ?? fetch;
    const userContent = JSON.stringify(
      pairs.map((pair, i) => ({ i, a: pair.aText, b: pair.bText })),
    );
    const response = await fetchImpl(
      `${config.endpoint.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: 'system', content: JUDGE_SYSTEM_PROMPT },
            { role: 'user', content: userContent },
          ],
          temperature: 0,
        }),
        signal: AbortSignal.timeout(config.timeoutMs ?? JUDGE_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new Error(`Contradiction judge HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content ?? '';
    return parseJudgeReply(content)
      .filter((r) => r.i >= 0 && r.i < pairs.length)
      .map((r) => ({
        aId: pairs[r.i]!.aId,
        bId: pairs[r.i]!.bId,
        contradicts: r.contradicts,
        ...(r.topic ? { topic: r.topic } : {}),
      }));
  };
}

export async function detectContradictions(
  projectId: string,
  opts: DetectContradictionsOptions,
): Promise<DetectContradictionsResult> {
  try {
    const embedder = opts.embedder ?? getEmbedder();
    if (!embedder) return { detected: 0 };
    const judge = opts.judge ?? makeLlmJudge();
    if (!judge) return { detected: 0 };

    const decisions = listValidMemories(projectId)
      .map((row) => row.memory)
      .filter((memory) => memory.kind === 'decision');
    if (decisions.length < 2) return { detected: 0 };

    const vectorById = new Map(
      listEmbeddings(projectId, 'memory').map((row) => [row.entityId, row.vector]),
    );
    const threshold = opts.threshold ?? DEFAULT_THRESHOLD;

    const candidates: Array<{ a: MemoryRecord; b: MemoryRecord; sim: number }> =
      [];
    for (let i = 0; i < decisions.length; i += 1) {
      for (let j = i + 1; j < decisions.length; j += 1) {
        const va = vectorById.get(decisions[i]!.id);
        const vb = vectorById.get(decisions[j]!.id);
        if (!va || !vb) continue;
        const sim = cosineSimilarity(va, vb);
        if (sim >= threshold) {
          candidates.push({ a: decisions[i]!, b: decisions[j]!, sim });
        }
      }
    }
    if (candidates.length === 0) return { detected: 0 };

    candidates.sort((x, y) => y.sim - x.sim);
    const maxPairs = opts.maxPairs ?? DEFAULT_MAX_PAIRS;
    const capped = candidates.slice(0, maxPairs);
    if (candidates.length > maxPairs) {
      process.stderr.write(
        `WARN: contradiction candidates capped ${candidates.length}->${maxPairs}\n`,
      );
    }

    const verdicts = await judge(
      capped.map((pair) => ({
        aId: pair.a.id,
        aText: pair.a.text,
        bId: pair.b.id,
        bText: pair.b.text,
      })),
    );
    const pairKey = (x: string, y: string): string =>
      x < y ? `${x}|${y}` : `${y}|${x}`;
    const verdictByPair = new Map(
      verdicts.map((v) => [pairKey(v.aId, v.bId), v]),
    );

    const inputs: AppendEventInput<DomainEventPayload>[] = [];
    const touched = new Set<string>();
    let detected = 0;
    for (const pair of capped) {
      const verdict = verdictByPair.get(pairKey(pair.a.id, pair.b.id));
      if (!verdict || !verdict.contradicts) continue;
      // One memory per pass acts as winner OR loser at most once, so a chain
      // (A>B>C) resolves over successive boundaries, not ambiguously in one.
      if (touched.has(pair.a.id) || touched.has(pair.b.id)) continue;

      const [loser, winner] = orderByRecency(pair.a, pair.b);
      const topic = verdict.topic?.trim() || 'contradicting decisions';
      const concurrent = Boolean(
        loser.sessionId &&
          winner.sessionId &&
          loser.sessionId !== winner.sessionId,
      );

      const supersede: MemorySupersededPayload = {
        supersedes: loser.id,
        supersededBy: winner.id,
        reason: `Semantic contradiction (auto): ${topic}`,
      };
      inputs.push({
        type: 'memory.superseded',
        projectId,
        scopeType: 'session',
        scopeId: opts.sessionId ?? projectId,
        actor: opts.actor,
        payload: supersede,
      });

      const conflict = createConflict({
        projectId,
        scopeType: 'decision',
        scopeId: winner.id,
        fieldPath: topic,
        leftVersion: loser.text,
        rightVersion: winner.text,
        conflictType: 'decision',
        ...(concurrent ? { concurrent: true } : {}),
      });
      inputs.push({
        type: 'conflict.detected',
        projectId,
        scopeType: 'project',
        // The projector keys state.conflicts by the EVENT scopeId, so it must be
        // the conflict id (not the projectId) for distinct conflicts to survive.
        scopeId: conflict.id,
        actor: opts.actor,
        payload: conflict,
      });

      touched.add(loser.id);
      touched.add(winner.id);
      detected += 1;
    }

    if (inputs.length === 0) return { detected: 0 };
    await appendEvents(projectId, inputs);
    await rebuildProjectProjection(projectId, { reindexSearch: true });
    return { detected };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`WARN: contradiction detection deferred (${message})\n`);
    return { detected: 0 };
  }
}
