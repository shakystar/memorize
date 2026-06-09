import type { Observation } from '../domain/entities.js';
import { nowIso } from '../domain/common.js';
import type { MemoryRecord } from '../projections/projector.js';
import {
  listRecentObservations,
  listValidMemories,
  touchMemoryAccess,
} from './projection-store.js';
import { searchProject } from './search-service.js';

/**
 * CLS Phase 1 — retrieval-time ranking for startup injection (decision ②,
 * 2026-06-08: single pool + per-layer weight coefficients).
 *
 * Forgetting is retrieval-time ONLY (D4): nothing is deleted, low scores
 * just fall outside the budget. Decay is deterministic (createdAt-based);
 * reinforcement (lastAccessedAt) is the best-effort projection signal that
 * bumps effective recency when present (decision ⑤).
 *
 * Every constant below is a TUNING PARAMETER (start values from the
 * 2026-06-08 decisions) — adjust against real transcripts, not in advance.
 */
export const LONG_TERM_WEIGHT = 0.7;
export const SHORT_TERM_WEIGHT = 0.3;
/** Char budget for the combined memory+observation pool. Sits INSIDE the
 *  renderer's overall MAX_STARTUP_CONTEXT_CHARS (8000) so injected memory
 *  can never evict the task/handoff blocks wholesale. */
export const MEMORY_POOL_BUDGET_CHARS = 4000;
/** Recency half-life for the exponential decay term, in days. */
export const RECENCY_HALF_LIFE_DAYS = 14;
/** Short-term tail window: most recent N observations within MAX_AGE. */
export const OBSERVATION_TAIL_LIMIT = 20;
export const OBSERVATION_TAIL_MAX_AGE_HOURS = 24;
/** Additive boost when FTS relevance links a memory to the current task. */
export const RELEVANCE_BOOST = 0.3;

export interface RankedMemory {
  memory: MemoryRecord;
  score: number;
}

export interface RetrievedMemoryContext {
  memories: RankedMemory[];
  observations: Observation[];
}

function recencyScore(referenceIso: string, nowMs: number): number {
  const ageMs = Math.max(0, nowMs - Date.parse(referenceIso));
  const ageDays = ageMs / 86_400_000;
  // exp decay scaled so score = 0.5 at exactly one half-life.
  return Math.exp((-Math.LN2 * ageDays) / RECENCY_HALF_LIFE_DAYS);
}

/**
 * Rank the long-term and short-term layers in ONE pool and take the best
 * entries that fit the char budget. Layer weights (not split budgets) are
 * what bias the mix toward consolidated meaning over raw tail.
 */
export function retrieveMemoryContext(
  projectId: string,
  opts: {
    /** Current task title — drives the FTS relevance boost when present. */
    taskTitle?: string;
    /** ISO timestamp for deterministic tests; defaults to now. */
    nowIso?: string;
    /**
     * P3-c — optional id→cosine-similarity (in [0,1]) for the task, computed by
     * the caller (async, best-effort). When present, a GRADED semantic boost
     * (RELEVANCE_BOOST × similarity) replaces/augments the binary FTS boost. When
     * absent (no embeddings endpoint, or the embed timed out), ranking is exactly
     * the pre-P3-c FTS behavior.
     */
    semanticScores?: Map<string, number>;
  } = {},
): RetrievedMemoryContext {
  const nowMs = Date.parse(opts.nowIso ?? nowIso());

  // Relevance: which valid memories match the current task title?
  let relevantIds = new Set<string>();
  if (opts.taskTitle) {
    relevantIds = new Set(
      searchProject(projectId, opts.taskTitle)
        .filter((hit) => hit.kind === 'memory')
        .map((hit) => hit.entityId),
    );
  }

  interface PoolEntry {
    score: number;
    chars: number;
    memory?: RankedMemory;
    observation?: Observation;
  }
  const pool: PoolEntry[] = [];

  for (const row of listValidMemories(projectId)) {
    const { memory, lastAccessedAt } = row;
    // Reinforcement: a re-referenced memory decays from its last access,
    // not its creation (best-effort — resets with a from-scratch replay).
    const reference =
      lastAccessedAt && lastAccessedAt > memory.createdAt
        ? lastAccessedAt
        : memory.createdAt;
    const base =
      0.5 * (memory.salience / 10) + 0.5 * recencyScore(reference, nowMs);
    // Relevance boost: take the stronger of the binary FTS signal and the
    // graded semantic signal (when P3-c embeddings are configured). No semantic
    // scores → identical to the pre-P3-c FTS-only boost.
    const ftsBoost = relevantIds.has(memory.id) ? RELEVANCE_BOOST : 0;
    const semBoost = opts.semanticScores
      ? RELEVANCE_BOOST * Math.max(0, opts.semanticScores.get(memory.id) ?? 0)
      : 0;
    const score = LONG_TERM_WEIGHT * (base + Math.max(ftsBoost, semBoost));
    pool.push({
      score,
      chars: memory.text.length + 24,
      memory: { memory, score },
    });
  }

  const sinceIso = new Date(
    nowMs - OBSERVATION_TAIL_MAX_AGE_HOURS * 3_600_000,
  ).toISOString();
  for (const observation of listRecentObservations(projectId, {
    limit: OBSERVATION_TAIL_LIMIT,
    sinceIso,
  })) {
    const score =
      SHORT_TERM_WEIGHT * recencyScore(observation.createdAt, nowMs);
    pool.push({
      score,
      chars: (observation.summary?.length ?? 16) + 24,
      observation,
    });
  }

  pool.sort((a, b) => b.score - a.score);
  const memories: RankedMemory[] = [];
  const observations: Observation[] = [];
  let spent = 0;
  for (const entry of pool) {
    if (spent + entry.chars > MEMORY_POOL_BUDGET_CHARS) continue;
    spent += entry.chars;
    if (entry.memory) memories.push(entry.memory);
    if (entry.observation) observations.push(entry.observation);
  }

  return { memories, observations };
}

/**
 * Reinforcement stamp for the memories that were actually injected.
 * Projection-only UPDATE — events stay append-only.
 */
export function reinforceInjectedMemories(
  projectId: string,
  memories: RankedMemory[],
): void {
  touchMemoryAccess(
    projectId,
    memories.map((entry) => entry.memory.id),
    nowIso(),
  );
}
