import fs from 'node:fs/promises';
import path from 'node:path';

import {
  type ConsolidatedMemory,
  type ConsolidatedMemoryKind,
  type MemorySupersededPayload,
  type Observation,
  clampSalience,
  createConsolidatedMemory,
} from '../domain/entities.js';
import type { DomainEventPayload } from '../domain/events.js';
import { getDb } from '../storage/db.js';
import {
  type AppendEventInput,
  appendEvents,
  readEventsSince,
} from '../storage/event-store.js';
import { withFileLock } from '../storage/file-lock.js';
import { getProjectRoot } from '../storage/path-resolver.js';
import { ensureEmbeddings } from './embeddings-service.js';
import {
  listValidMemories,
  rebuildProjectProjection,
} from './projection-store.js';

/**
 * CLS Phase 1 — boundary consolidation (the expensive half of D3, run ONCE
 * per boundary: PostCompact, SessionEnd, or the next SessionStart's
 * catch-up).
 *
 * Idempotency contract: the watermark (last consolidated observation event
 * id, in the per-project `meta` table) advances ONLY after the consolidated
 * events are durably appended. A boundary that dies mid-way (SessionEnd's
 * subprocess being reaped, an LLM timeout) simply leaves the watermark
 * behind — the next boundary re-collects the same observations and retries.
 * Concurrent boundaries are serialized by a per-project file lock.
 */

const WATERMARK_META_KEY = 'cls_consolidate_watermark';

/** Upper bound on memories extracted per boundary (noise guard). */
const MAX_MEMORIES_PER_BOUNDARY = 12;

/** Defensive transcript tail size — consolidation input, never stored. */
const TRANSCRIPT_TAIL_BYTES = 16 * 1024;

// --- extractor interface (decision ①, 2026-06-08) ---------------------------

export interface ExtractedMemory {
  kind: ConsolidatedMemoryKind;
  text: string;
  salience: number;
  /** Id of an existing valid memory this one contradicts/replaces. */
  supersedesMemoryId?: string;
  supersedeReason?: string;
}

export interface ConsolidationInput {
  observations: Observation[];
  /** Tail of the agent transcript (defensive read; format is unstable). */
  transcriptTail?: string;
  /** Currently-valid memories, for contradiction checks. */
  existingMemories: ConsolidatedMemory[];
}

/**
 * Pluggable extractor. The LLM implementation is used when the user has
 * configured a key; otherwise the rule-based degraded extractor keeps the
 * pipeline working with zero install friction. Vendor independence is held
 * at this interface AND at the config level (any OpenAI-compatible
 * endpoint, including local models).
 */
export interface Consolidator {
  extract(input: ConsolidationInput): Promise<ExtractedMemory[]>;
}

// --- rule-based degraded extractor ------------------------------------------

/**
 * LLM-free fallback: classify by capture signal, aggregate file edits into
 * a single progress memory, and assign fixed salience per signal class.
 * Quality is intentionally modest — its job is "never worse than nothing"
 * when no key is configured.
 */
export class RuleBasedConsolidator implements Consolidator {
  async extract(input: ConsolidationInput): Promise<ExtractedMemory[]> {
    const out: ExtractedMemory[] = [];

    const edits = input.observations.filter((o) => o.signal === 'write-tool');
    if (edits.length > 0) {
      const files = [
        ...new Set(
          edits
            .map((o) => o.summary ?? '')
            .map((s) => s.replace(/^(Write|Edit|MultiEdit):\s*/, ''))
            .filter(Boolean),
        ),
      ];
      out.push({
        kind: 'progress',
        text: `Edited ${files.length} file(s): ${files.slice(0, 10).join(', ')}${files.length > 10 ? ', …' : ''}`,
        salience: clampSalience(3 + Math.min(2, Math.floor(files.length / 5))),
      });
    }

    for (const obs of input.observations) {
      if (!obs.summary) continue;
      if (obs.signal === 'decision-keyword') {
        out.push({ kind: 'decision', text: obs.summary, salience: 6 });
      } else if (obs.signal === 'task-transition') {
        out.push({ kind: 'progress', text: obs.summary, salience: 5 });
      } else if (obs.signal === 'mutating-bash') {
        out.push({ kind: 'progress', text: obs.summary, salience: 4 });
      }
    }

    return out.slice(0, MAX_MEMORIES_PER_BOUNDARY);
  }
}

// --- LLM extractor (OpenAI-compatible chat completions) ----------------------

export interface LlmConsolidatorConfig {
  /** Base URL of an OpenAI-compatible API (e.g. https://api.anthropic.com/v1, http://localhost:11434/v1). */
  endpoint: string;
  apiKey: string;
  model: string;
  /** HTTP timeout override. Boundaries that block the agent (SessionStart
   *  catch-up) pass a tight value; fire-and-forget boundaries use the
   *  default. */
  timeoutMs?: number;
  /** Test seam; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export const DEFAULT_LLM_ENDPOINT = 'https://api.anthropic.com/v1';
export const DEFAULT_LLM_MODEL = 'claude-haiku-4-5';
const LLM_TIMEOUT_MS = 20_000;

/**
 * Resolve the user's extractor config from env. All three values are
 * OPTIONAL — a missing key simply means the rule-based fallback runs
 * (decision ①: key-optional, zero install friction preserved). The
 * three-value shape (endpoint + key + model) is what lets one
 * implementation cover Anthropic, OpenAI, and local OpenAI-compatible
 * servers (Ollama, LM Studio) alike.
 */
export function resolveLlmConfig(
  env: NodeJS.ProcessEnv = process.env,
): LlmConsolidatorConfig | undefined {
  const apiKey = env.MEMORIZE_LLM_API_KEY;
  if (!apiKey) return undefined;
  return {
    endpoint: env.MEMORIZE_LLM_ENDPOINT ?? DEFAULT_LLM_ENDPOINT,
    apiKey,
    model: env.MEMORIZE_LLM_MODEL ?? DEFAULT_LLM_MODEL,
  };
}

const EXTRACTION_SYSTEM_PROMPT = [
  'You are a memory consolidator for a coding-agent memory system.',
  'From the raw observations and transcript tail, extract the durable',
  'semantic units a future session must know. Return ONLY a JSON array of:',
  '{"kind":"decision"|"rationale"|"progress","text":string,',
  '"salience":1-10,"supersedesMemoryId"?:string,"supersedeReason"?:string}',
  'Rules: text is one self-contained sentence; salience reflects how much a',
  'future session would regret not knowing it; set supersedesMemoryId ONLY',
  'when an existing memory (listed with its id) is contradicted by the new',
  'state. Extract nothing speculative. Empty array if nothing durable.',
].join(' ');

export class LlmConsolidator implements Consolidator {
  constructor(private readonly config: LlmConsolidatorConfig) {}

  async extract(input: ConsolidationInput): Promise<ExtractedMemory[]> {
    const fetchImpl = this.config.fetchImpl ?? fetch;
    const observationLines = input.observations.map(
      (o) => `- [${o.signal}${o.toolName ? `/${o.toolName}` : ''}] ${o.summary ?? '(no summary)'}`,
    );
    const memoryLines = input.existingMemories.map(
      (m) => `- id=${m.id} [${m.kind}] ${m.text}`,
    );
    const userContent = [
      '## Observations (this session window)',
      observationLines.join('\n') || '(none)',
      '',
      '## Existing valid memories (for contradiction check)',
      memoryLines.join('\n') || '(none)',
      ...(input.transcriptTail
        ? ['', '## Transcript tail (untrusted, format unstable)', input.transcriptTail]
        : []),
    ].join('\n');

    const response = await fetchImpl(
      `${this.config.endpoint.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
            { role: 'user', content: userContent },
          ],
          temperature: 0,
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? LLM_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new Error(`LLM extractor HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content ?? '';
    return parseExtractedMemories(content);
  }
}

/**
 * Defensive parse of the model's reply: locate the first JSON array, drop
 * malformed entries, clamp salience, cap count. A reply with no parseable
 * array yields [] (the boundary then simply consolidates nothing — the
 * watermark still advances because the observations WERE processed).
 */
export function parseExtractedMemories(content: string): ExtractedMemory[] {
  const start = content.indexOf('[');
  const end = content.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const kinds: ConsolidatedMemoryKind[] = ['decision', 'rationale', 'progress'];
  return parsed
    .filter(
      (item): item is Record<string, unknown> =>
        item !== null && typeof item === 'object' && !Array.isArray(item),
    )
    .map((item): ExtractedMemory | undefined => {
      const kind = item.kind;
      const text = item.text;
      if (typeof text !== 'string' || text.trim().length === 0) return undefined;
      if (typeof kind !== 'string' || !kinds.includes(kind as ConsolidatedMemoryKind)) {
        return undefined;
      }
      return {
        kind: kind as ConsolidatedMemoryKind,
        text: text.trim(),
        salience: clampSalience(
          typeof item.salience === 'number' ? item.salience : 5,
        ),
        ...(typeof item.supersedesMemoryId === 'string'
          ? { supersedesMemoryId: item.supersedesMemoryId }
          : {}),
        ...(typeof item.supersedeReason === 'string'
          ? { supersedeReason: item.supersedeReason }
          : {}),
      };
    })
    .filter((item): item is ExtractedMemory => item !== undefined)
    .slice(0, MAX_MEMORIES_PER_BOUNDARY);
}

// --- watermark ---------------------------------------------------------------

function readWatermark(projectId: string): string | undefined {
  const row = getDb(projectId)
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get(WATERMARK_META_KEY) as { value: string } | undefined;
  return row?.value;
}

function writeWatermark(projectId: string, eventId: string): void {
  getDb(projectId)
    .prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(WATERMARK_META_KEY, eventId);
}

// --- transcript tail ---------------------------------------------------------

/**
 * Best-effort transcript tail. Both agents warn that the transcript format
 * is not a stable interface, so this never parses — it just hands the raw
 * tail to the extractor as auxiliary context. Any failure returns
 * undefined; consolidation proceeds on observations alone.
 */
async function readTranscriptTail(
  transcriptPath: string | undefined,
): Promise<string | undefined> {
  if (!transcriptPath) return undefined;
  try {
    const handle = await fs.open(transcriptPath, 'r');
    try {
      const { size } = await handle.stat();
      const offset = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
      const length = size - offset;
      if (length <= 0) return undefined;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);
      return buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

// --- consolidate -------------------------------------------------------------

export interface ConsolidateResult {
  /** New memory.consolidated events appended. */
  consolidated: number;
  /** memory.superseded events appended. */
  superseded: number;
  /** Observations processed in this boundary window. */
  observationsProcessed: number;
  extractor: 'llm' | 'rule-based' | 'custom' | 'none';
}

const NOOP_RESULT: ConsolidateResult = {
  consolidated: 0,
  superseded: 0,
  observationsProcessed: 0,
  extractor: 'none',
};

/**
 * Observation ids already consumed by ANY consolidated memory (valid or
 * superseded). The dedup safety net for watermark loss: events survive
 * export/sync/migrate, but the per-project meta table (and thus the
 * watermark) does not — without this guard a fresh meta table would make
 * the next boundary re-consolidate the project's entire observation
 * history into duplicate memories.
 */
function consumedObservationIds(projectId: string): Set<string> {
  const rows = getDb(projectId)
    .prepare('SELECT data FROM memories')
    .all() as Array<{ data: string }>;
  const consumed = new Set<string>();
  for (const row of rows) {
    const memory = JSON.parse(row.data) as ConsolidatedMemory;
    for (const id of memory.sourceObservationIds ?? []) consumed.add(id);
  }
  return consumed;
}

/**
 * Run one consolidation boundary for a project. Safe to call from any
 * boundary hook (PostCompact / SessionEnd / SessionStart catch-up):
 * watermark-idempotent, lock-serialized, and a no-op when nothing new was
 * observed.
 */
export async function consolidate(params: {
  projectId: string;
  actor: string;
  sessionId?: string;
  /** LLM HTTP timeout for THIS boundary (SessionStart catch-up passes a
   *  tight value because Claude blocks startup on the hook's output). */
  llmTimeoutMs?: number;
  /** Override extractor (tests). Defaults to LLM-if-configured else rules. */
  consolidator?: Consolidator;
}): Promise<ConsolidateResult> {
  return withFileLock(
    path.join(getProjectRoot(params.projectId), 'locks'),
    'consolidate',
    async () => {
      const watermark = readWatermark(params.projectId);
      const eventsSince = await readEventsSince(params.projectId, watermark);
      const rawObservationEvents = eventsSince.filter(
        (event) => event.type === 'observation.captured',
      );
      if (rawObservationEvents.length === 0) return NOOP_RESULT;

      // Dedup guard for watermark loss (see consumedObservationIds): drop
      // observations a previous consolidation already distilled. When this
      // leaves nothing, still advance the watermark so the stale window is
      // not rescanned at every subsequent boundary.
      const consumed = consumedObservationIds(params.projectId);
      const observationEvents = rawObservationEvents.filter(
        (event) => !consumed.has((event.payload as Observation).id),
      );
      if (observationEvents.length === 0) {
        writeWatermark(
          params.projectId,
          rawObservationEvents[rawObservationEvents.length - 1]!.id,
        );
        return NOOP_RESULT;
      }

      const observations = observationEvents.map(
        (event) => event.payload as Observation,
      );
      const transcriptTail = await readTranscriptTail(
        [...observations].reverse().find((o) => o.transcriptPath)
          ?.transcriptPath,
      );
      const existing = listValidMemories(params.projectId).map(
        (row) => row.memory,
      );

      const llmConfig = resolveLlmConfig();
      const consolidator =
        params.consolidator ??
        (llmConfig
          ? new LlmConsolidator({
              ...llmConfig,
              ...(params.llmTimeoutMs ? { timeoutMs: params.llmTimeoutMs } : {}),
            })
          : new RuleBasedConsolidator());
      const extractorKind: ConsolidateResult['extractor'] = params.consolidator
        ? 'custom'
        : llmConfig
          ? 'llm'
          : 'rule-based';

      // Extractor failure (LLM timeout, HTTP error) intentionally propagates
      // WITHOUT advancing the watermark — the next boundary retries the same
      // window. Callers at hook boundaries catch and degrade.
      const extracted = await consolidator.extract({
        observations,
        ...(transcriptTail ? { transcriptTail } : {}),
        existingMemories: existing,
      });

      const validIds = new Set(existing.map((m) => m.id));
      const sourceObservationIds = observations.map((o) => o.id);
      const inputs: AppendEventInput<DomainEventPayload>[] = [];
      let supersededCount = 0;

      for (const item of extracted) {
        const memory = createConsolidatedMemory({
          projectId: params.projectId,
          kind: item.kind,
          text: item.text,
          salience: item.salience,
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
          sourceObservationIds,
        });
        inputs.push({
          type: 'memory.consolidated',
          projectId: params.projectId,
          scopeType: 'session',
          scopeId: params.sessionId ?? params.projectId,
          actor: params.actor,
          payload: memory,
        });
        // Only supersede memories that actually exist and are still valid —
        // a hallucinated or stale id must not produce a dangling event.
        if (item.supersedesMemoryId && validIds.has(item.supersedesMemoryId)) {
          const payload: MemorySupersededPayload = {
            supersedes: item.supersedesMemoryId,
            supersededBy: memory.id,
            reason: item.supersedeReason ?? 'Contradicted by newer memory',
          };
          inputs.push({
            type: 'memory.superseded',
            projectId: params.projectId,
            scopeType: 'session',
            scopeId: params.sessionId ?? params.projectId,
            actor: params.actor,
            payload,
          });
          validIds.delete(item.supersedesMemoryId);
          supersededCount += 1;
        }
      }

      if (inputs.length > 0) {
        await appendEvents(params.projectId, inputs);
        // Memories ARE searchable — this boundary rebuild is where the FTS
        // reindex deferred by every capture (reindexSearch:false) happens.
        // Skipped when the extractor returned nothing: no event was
        // appended, so the projection (and FTS — observations are not
        // searchable) is already current.
        await rebuildProjectProjection(params.projectId, {
          reindexSearch: true,
        });
        // P3-c — refresh the semantic index for the memories just consolidated.
        // Best-effort and never-throw: a missing/failing embeddings endpoint is
        // a silent no-op (FTS5 still covers these memories). Runs only at this
        // boundary, never per-turn.
        await ensureEmbeddings(params.projectId);
      }
      writeWatermark(
        params.projectId,
        rawObservationEvents[rawObservationEvents.length - 1]!.id,
      );

      return {
        consolidated: extracted.length,
        superseded: supersededCount,
        observationsProcessed: observations.length,
        extractor: extractorKind,
      };
    },
  );
}
