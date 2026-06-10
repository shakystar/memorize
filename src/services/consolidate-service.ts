import fs from 'node:fs/promises';
import path from 'node:path';

import spawn from 'cross-spawn';
import which from 'which';

import { nowIso } from '../domain/common.js';
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
import { detectContradictions } from './contradiction-service.js';
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

/**
 * #51 — outcome of the LAST consolidation attempt (success AND failure),
 * stored next to the watermark in the per-project meta table. Meta, not an
 * event: attempts are machine-local operational telemetry, and retries of a
 * failing boundary must not pollute the append-only log or sync to siblings.
 * Single overwritten row — it is "last attempt", not a history.
 */
export const LAST_ATTEMPT_META_KEY = 'cls_consolidate_last_attempt';

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
  /** HTTP timeout override (MEMORIZE_LLM_TIMEOUT_MS; built-in default). */
  timeoutMs?: number;
  /** Test seam; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export const DEFAULT_LLM_ENDPOINT = 'https://api.anthropic.com/v1';
export const DEFAULT_LLM_MODEL = 'claude-haiku-4-5';
/** HTTP default; override via MEMORIZE_LLM_TIMEOUT_MS (local CPU models can
 *  need minutes). The host-CLI extractor has its own default (CLI_TIMEOUT_MS). */
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
  const timeoutMs = resolveTimeoutMsEnv(env);
  return {
    endpoint: env.MEMORIZE_LLM_ENDPOINT ?? DEFAULT_LLM_ENDPOINT,
    apiKey,
    model: env.MEMORIZE_LLM_MODEL ?? DEFAULT_LLM_MODEL,
    // Invalid/non-positive values fall back to the built-in default.
    ...(timeoutMs ? { timeoutMs } : {}),
  };
}

/** MEMORIZE_LLM_TIMEOUT_MS, shared by the HTTP and host-CLI extractors.
 *  Invalid/non-positive values read as unset (built-in default applies). */
function resolveTimeoutMsEnv(env: NodeJS.ProcessEnv): number | undefined {
  const timeoutMs = Number.parseInt(env.MEMORIZE_LLM_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined;
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

/** Prompt body shared verbatim by the HTTP and host-CLI extractors. */
function buildExtractionUserContent(input: ConsolidationInput): string {
  const observationLines = input.observations.map(
    (o) => `- [${o.signal}${o.toolName ? `/${o.toolName}` : ''}] ${o.summary ?? '(no summary)'}`,
  );
  const memoryLines = input.existingMemories.map(
    (m) => `- id=${m.id} [${m.kind}] ${m.text}`,
  );
  return [
    '## Observations (this session window)',
    observationLines.join('\n') || '(none)',
    '',
    '## Existing valid memories (for contradiction check)',
    memoryLines.join('\n') || '(none)',
    ...(input.transcriptTail
      ? ['', '## Transcript tail (untrusted, format unstable)', input.transcriptTail]
      : []),
  ].join('\n');
}

export class LlmConsolidator implements Consolidator {
  constructor(private readonly config: LlmConsolidatorConfig) {}

  async extract(input: ConsolidationInput): Promise<ExtractedMemory[]> {
    const fetchImpl = this.config.fetchImpl ?? fetch;
    const userContent = buildExtractionUserContent(input);

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

// --- host-CLI extractor (claude -p / codex exec) — #44 ------------------------

export type HostCliCommand = 'claude' | 'codex';

/**
 * Env var set on the spawned host CLI so the memorize hooks ITS session
 * fires (SessionStart/PostToolUse/...) no-op. Without it the extractor's
 * own invocation would be captured and consolidated, recursing forever:
 * consolidate → claude -p → SessionStart hook → consolidate → ...
 */
export const SUPPRESS_HOOKS_ENV_VAR = 'MEMORIZE_SUPPRESS_HOOKS';

/** Minimal child-process surface CliConsolidator needs (test-fakeable). */
export interface CliExtractorChild {
  stdout: {
    on(event: 'data', listener: (chunk: unknown) => void): unknown;
  } | null;
  stderr: {
    on(event: 'data', listener: (chunk: unknown) => void): unknown;
  } | null;
  stdin: { end(data: string): unknown } | null;
  kill(): boolean;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
}

/** Spawn seam (test-injectable; cross-spawn satisfies it). */
export type SpawnImpl = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => CliExtractorChild;

export interface CliConsolidatorConfig {
  command: HostCliCommand;
  /** Same precedence as the HTTP timeout; backend-specific default (#55). */
  timeoutMs?: number;
  /** Test seam; defaults to cross-spawn. */
  spawnImpl?: SpawnImpl;
}

/**
 * Host-CLI default; override via MEMORIZE_LLM_TIMEOUT_MS. Higher than the
 * HTTP default: `claude -p` cold-starts in 3–10s and a real extraction takes
 * tens of seconds (~31.5s measured), so 90s leaves margin. Since boundaries
 * spawn consolidation detached (#46) this only reaps stuck children — it no
 * longer protects interactive latency.
 */
const CLI_TIMEOUT_MS = 90_000;

const CLI_EXTRACTOR_ARGS: Record<HostCliCommand, string[]> = {
  claude: ['-p', '--output-format', 'text'],
  // `-` = read the prompt from stdin (verified against codex exec --help).
  codex: ['exec', '-', '--skip-git-repo-check', '--color', 'never'],
};

/**
 * Host-CLI extractor: runs the user's installed `claude -p` / `codex exec`
 * with their existing subscription auth — zero extra setup, no API key.
 * The prompt goes via stdin (Windows argv length/quoting limits), and the
 * combined system+user text in one block (`claude -p` has no separate
 * system channel).
 */
export class CliConsolidator implements Consolidator {
  constructor(private readonly config: CliConsolidatorConfig) {}

  async extract(input: ConsolidationInput): Promise<ExtractedMemory[]> {
    const prompt = `${EXTRACTION_SYSTEM_PROMPT}\n\n${buildExtractionUserContent(input)}`;
    const stdout = await this.runCli(prompt);
    return parseExtractedMemories(stdout);
  }

  private runCli(prompt: string): Promise<string> {
    const spawnImpl: SpawnImpl = this.config.spawnImpl ?? spawn;
    const timeoutMs = this.config.timeoutMs ?? CLI_TIMEOUT_MS;
    const { command } = this.config;
    return new Promise<string>((resolve, reject) => {
      const child = spawnImpl(command, CLI_EXTRACTOR_ARGS[command], {
        env: { ...process.env, [SUPPRESS_HOOKS_ENV_VAR]: '1' },
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      // Same contract as the HTTP timeout: kill and THROW (never return [])
      // so the watermark stays behind and the next boundary retries.
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(
            new Error(`${command} CLI extractor timed out after ${timeoutMs}ms`),
          );
        } else if (code !== 0) {
          const detail = stderr.trim().slice(0, 200);
          reject(
            new Error(
              `${command} CLI extractor exited with code ${code}${detail ? `: ${detail}` : ''}`,
            ),
          );
        } else if (stdout.trim().length === 0) {
          reject(new Error(`${command} CLI extractor produced no output`));
        } else {
          resolve(stdout);
        }
      });
      child.stdin?.end(prompt);
    });
  }
}

// --- backend resolution (#44 priority order) ----------------------------------

export type ConsolidatorBackend =
  | { kind: 'llm'; config: LlmConsolidatorConfig }
  | { kind: 'cli'; command: HostCliCommand; timeoutMs?: number }
  | { kind: 'rule-based' };

let warnedUnknownBackend = false;

/**
 * Pick the extractor backend (#44):
 * 1. MEMORIZE_LLM_BACKEND explicit — `claude-cli` | `codex-cli` | `off`
 *    (off = rule-based, disables LLM entirely; unknown values read as unset).
 * 2. MEMORIZE_LLM_API_KEY set — existing HTTP LlmConsolidator (unchanged).
 * 3. Auto-detect a host CLI on PATH (claude, then codex): highest-quality
 *    zero-setup extractor via the user's existing agent subscription auth.
 * 4. Nothing available — rule-based fallback.
 */
export function resolveConsolidatorBackend(
  env: NodeJS.ProcessEnv = process.env,
  isOnPath: (command: HostCliCommand) => boolean = (command) =>
    which.sync(command, { nothrow: true }) !== null,
): ConsolidatorBackend {
  const timeoutMs = resolveTimeoutMsEnv(env);
  const cli = (command: HostCliCommand): ConsolidatorBackend => ({
    kind: 'cli',
    command,
    ...(timeoutMs ? { timeoutMs } : {}),
  });

  const explicit = env.MEMORIZE_LLM_BACKEND;
  if (explicit === 'off') return { kind: 'rule-based' };
  if (explicit === 'claude-cli') return cli('claude');
  if (explicit === 'codex-cli') return cli('codex');
  if (explicit && !warnedUnknownBackend) {
    warnedUnknownBackend = true;
    process.stderr.write(
      `WARN: unknown MEMORIZE_LLM_BACKEND "${explicit}" (expected claude-cli|codex-cli|off); ignoring\n`,
    );
  }

  const llmConfig = resolveLlmConfig(env);
  if (llmConfig) return { kind: 'llm', config: llmConfig };
  if (isOnPath('claude')) return cli('claude');
  if (isOnPath('codex')) return cli('codex');
  return { kind: 'rule-based' };
}

/**
 * Extractor FAILURE: the model replied 200 OK but with no parseable JSON
 * array (weak local models emitting junk). Distinct from a genuine empty
 * `[]` — it propagates like an HTTP error or timeout, so the watermark
 * does not advance and the next boundary retries the same window.
 */
export class ExtractionParseError extends Error {}

/**
 * Defensive parse of the model's reply: locate the first JSON array, drop
 * malformed entries, clamp salience, cap count. A reply with NO parseable
 * array is an extractor failure and throws ExtractionParseError — only a
 * cleanly parsed result (including an empty array) lets the boundary
 * advance the watermark and consume the observations.
 */
export function parseExtractedMemories(content: string): ExtractedMemory[] {
  const start = content.indexOf('[');
  const end = content.lastIndexOf(']');
  if (start === -1 || end <= start) {
    throw new ExtractionParseError('LLM reply contains no JSON array');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    throw new ExtractionParseError('LLM reply array is not valid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new ExtractionParseError('LLM reply JSON is not an array');
  }
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

// --- attempt telemetry (#51) -------------------------------------------------

export const CONSOLIDATE_BOUNDARIES = [
  'session-start',
  'post-compact',
  'session-end',
  'manual',
] as const;

/** Which boundary triggered an attempt (telemetry label only). */
export type ConsolidateBoundary = (typeof CONSOLIDATE_BOUNDARIES)[number];

export type ConsolidateAttemptOutcome =
  | 'ok'
  | 'noop'
  | 'timeout'
  | 'http-error'
  | 'parse-error'
  | 'lock-contention'
  | 'error';

export interface ConsolidateAttempt {
  /** ISO timestamp of when the attempt finished. */
  at: string;
  boundary: ConsolidateBoundary;
  /** llm | cli:claude | cli:codex | rule-based | custom (injected). */
  backend: string;
  outcome: ConsolidateAttemptOutcome;
  /** observation.captured events past the watermark when the attempt ran;
   *  -1 when the attempt failed before the count (e.g. lock contention). */
  pendingObservations: number;
  durationMs: number;
  /** memory.consolidated events appended (success only). */
  consolidated?: number;
  /** Truncated failure message (failures only). */
  error?: string;
}

/** Cap on the recorded error message — telemetry, not a stack archive. */
const ATTEMPT_ERROR_MAX_CHARS = 300;

/** Map a consolidation failure onto the #51 outcome vocabulary. */
export function classifyConsolidateError(
  error: unknown,
): ConsolidateAttemptOutcome {
  if (error instanceof ExtractionParseError) return 'parse-error';
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  if (message.startsWith('withFileLock')) return 'lock-contention';
  // CLI extractor: "<command> CLI extractor timed out after Nms";
  // HTTP extractor: AbortSignal.timeout rejects with name 'TimeoutError'.
  if (name === 'TimeoutError' || /timed out/i.test(message)) return 'timeout';
  if (/HTTP \d/.test(message)) return 'http-error';
  return 'error';
}

export function readLastConsolidateAttempt(
  projectId: string,
): ConsolidateAttempt | undefined {
  const row = getDb(projectId)
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get(LAST_ATTEMPT_META_KEY) as { value: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.value) as ConsolidateAttempt;
  } catch {
    return undefined;
  }
}

function writeLastConsolidateAttempt(
  projectId: string,
  attempt: ConsolidateAttempt,
): void {
  getDb(projectId)
    .prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(LAST_ATTEMPT_META_KEY, JSON.stringify(attempt));
}

export interface ConsolidationStatus {
  /** observation.captured events past the current watermark. */
  pendingObservations: number;
  /** created_at of the oldest pending observation, when any. */
  oldestPendingAt?: string;
  lastAttempt?: ConsolidateAttempt;
}

/** Consolidation health snapshot for `memorize doctor` (#51). */
export function getConsolidationStatus(projectId: string): ConsolidationStatus {
  const db = getDb(projectId);
  const watermark = readWatermark(projectId);
  let sinceSeq = 0;
  if (watermark) {
    const row = db
      .prepare('SELECT seq FROM events WHERE id = ?')
      .get(watermark) as { seq: number } | undefined;
    if (row) sinceSeq = row.seq;
  }
  const pending = db
    .prepare(
      'SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM events ' +
        "WHERE type = 'observation.captured' AND seq > ?",
    )
    .get(sinceSeq) as { n: number; oldest: string | null };
  const lastAttempt = readLastConsolidateAttempt(projectId);
  return {
    pendingObservations: pending.n,
    ...(pending.oldest ? { oldestPendingAt: pending.oldest } : {}),
    ...(lastAttempt ? { lastAttempt } : {}),
  };
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
  extractor: 'llm' | 'cli' | 'rule-based' | 'custom' | 'none';
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
/**
 * Hold/steal horizon for the consolidate lock. withFileLock's 5s default
 * is sized for sub-second critical sections (session-start), but a
 * consolidation legitimately holds the lock for a full LLM extraction —
 * HTTP default 20s, and the #44 host-CLI extractor (cold start, local
 * models, env-raised MEMORIZE_LLM_TIMEOUT_MS) can run far longer. A flat
 * generous horizon keeps a concurrent boundary from force-reclaiming the
 * lock mid-extraction and double-consolidating the same window (LLM
 * nondeterminism → different texts → dedup won't collapse them), while a
 * genuinely crashed holder is still reclaimed eventually. Boundaries run
 * detached in the background (#46), so a contending boundary waiting on
 * this lock blocks no agent.
 */
const CONSOLIDATE_LOCK_HOLD_TIMEOUT_MS = 180_000;

export async function consolidate(params: {
  projectId: string;
  actor: string;
  sessionId?: string;
  /** Boundary that triggered this attempt — telemetry label only (#51). */
  boundary?: ConsolidateBoundary;
  /** Override extractor (tests). Defaults to LLM-if-configured else rules. */
  consolidator?: Consolidator;
}): Promise<ConsolidateResult> {
  const startedAt = Date.now();

  // Backend is resolved BEFORE the lock so even a lock-contention failure
  // records which extractor would have run (#51). Construction here has no
  // side effects — nothing runs until extract() is called.
  let consolidator: Consolidator;
  let extractorKind: ConsolidateResult['extractor'];
  let backendLabel: string;
  if (params.consolidator) {
    consolidator = params.consolidator;
    extractorKind = 'custom';
    backendLabel = 'custom';
  } else {
    const backend = resolveConsolidatorBackend();
    if (backend.kind === 'llm') {
      consolidator = new LlmConsolidator(backend.config);
      extractorKind = 'llm';
      backendLabel = 'llm';
    } else if (backend.kind === 'cli') {
      consolidator = new CliConsolidator({
        command: backend.command,
        ...(backend.timeoutMs ? { timeoutMs: backend.timeoutMs } : {}),
      });
      extractorKind = 'cli';
      backendLabel = `cli:${backend.command}`;
    } else {
      consolidator = new RuleBasedConsolidator();
      extractorKind = 'rule-based';
      backendLabel = 'rule-based';
    }
  }

  // -1 = the attempt failed before the count was taken (lock contention).
  let pendingObservations = -1;

  // #51: record how EVERY attempt ended — success AND failure — so a store
  // with 0 memories can answer "why" instead of looking like "never ran".
  // Best-effort: a failing telemetry write must never mask the attempt's
  // own result or error.
  const recordAttempt = (
    outcome: ConsolidateAttemptOutcome,
    extra: { consolidated?: number; error?: string } = {},
  ): void => {
    try {
      writeLastConsolidateAttempt(params.projectId, {
        at: nowIso(),
        boundary: params.boundary ?? 'manual',
        backend: backendLabel,
        outcome,
        pendingObservations,
        durationMs: Date.now() - startedAt,
        ...extra,
      });
    } catch {
      // Swallow: telemetry only — the original outcome must propagate.
    }
  };

  const runLocked = (): Promise<ConsolidateResult> =>
    withFileLock(
    path.join(getProjectRoot(params.projectId), 'locks'),
    'consolidate',
    async () => {
      const watermark = readWatermark(params.projectId);
      const eventsSince = await readEventsSince(params.projectId, watermark);
      const rawObservationEvents = eventsSince.filter(
        (event) => event.type === 'observation.captured',
      );
      pendingObservations = rawObservationEvents.length;
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

      // Extractor failure (LLM timeout, HTTP error, unparseable reply)
      // intentionally propagates WITHOUT advancing the watermark — the next
      // boundary retries the same window. Callers at hook boundaries catch
      // and degrade.
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
        // P3-c 2라운드 — surface semantic contradictions among decision memories
        // (newer wins, older superseded, conflict.detected raised). Needs both
        // embedder AND LLM; never-throw, no-op when either is unconfigured.
        await detectContradictions(params.projectId, {
          actor: params.actor,
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        });
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
    { holdTimeoutMs: CONSOLIDATE_LOCK_HOLD_TIMEOUT_MS },
    );

  let result: ConsolidateResult;
  try {
    result = await runLocked();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordAttempt(classifyConsolidateError(error), {
      error: message.slice(0, ATTEMPT_ERROR_MAX_CHARS),
    });
    throw error;
  }
  recordAttempt(
    result.observationsProcessed > 0 ? 'ok' : 'noop',
    result.observationsProcessed > 0
      ? { consolidated: result.consolidated }
      : {},
  );
  return result;
}
