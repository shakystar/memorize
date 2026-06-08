import path from 'node:path';

import { type AdapterAgent, adapterRegistry } from '../adapters/index.js';
import { nowIso } from '../domain/common.js';
import {
  type ConsolidatedMemory,
  type FileConflictWarning,
  type LiveUpdate,
  type Observation,
  type SiblingMemoryItem,
  type SiblingObservationItem,
  createConflict,
} from '../domain/entities.js';
import { getDb } from '../storage/db.js';
import { appendEvent, readEventsSince } from '../storage/event-store.js';
import {
  getSession,
  listOpenConflicts,
  listRecentObservations,
  rebuildProjectProjection,
} from './projection-store.js';
import { resolveSessionContext } from './session-context.js';

/**
 * CLS Phase 2 — real-time sharing between PARALLEL sessions on the same
 * machine (the gap Phase 1 left open: Phase 1 shares point-in-time, at the
 * boundary → next-session-start; while two sessions run concurrently, neither
 * sees the other's new work until one of them hits a boundary).
 *
 * This is a READ-SIDE feature over the existing event log — no new event type
 * (the only event ever appended is an OPTIONAL `conflict.detected` promotion,
 * which already exists). After a PostToolUse capture, the hook reads the delta
 * of events SIBLING sessions appended since this session last looked, and
 * returns it as `hookSpecificOutput.additionalContext` (confirmed injectable
 * on Claude Code PostToolUse). Cost is a single seq-keyed DB read — no LLM, no
 * FTS — so it respects the "no expensive per-turn work" lesson (rc.0..rc.4).
 *
 * Watermark-guarded: a per-session watermark (meta table, like the
 * consolidation watermark) records the highest event id already shared with
 * this session. Injection happens ONLY when sibling sessions actually produced
 * new events since then, so it is silent when nothing changed and naturally
 * rate-limited by sibling activity rather than this session's own tool use.
 */

// --- tuning parameters (constants — adjust against real dogfood) -------------
// The per-tool-call render budget (LIVE_UPDATE_BUDGET_CHARS) lives in
// adapters/shared/render-budget.ts — it is a render concern applied at the
// channel layer. The caps below bound the delta BEFORE rendering.

export const MAX_LIVE_OBSERVATIONS = 5;
export const MAX_LIVE_MEMORIES = 3;
export const MAX_LIVE_CONFLICTS = 3;
/** Recent self file-touch window used for collision detection. */
export const SELF_FILE_TOUCH_LIMIT = 20;
export const SELF_FILE_TOUCH_MAX_AGE_HOURS = 2;
/** Hard cap on the delta window scanned per call — a session whose watermark
 *  is very stale (idle while siblings churned) jumps straight to head rather
 *  than scanning thousands of events on a hot path. */
export const MAX_DELTA_SCAN = 200;

/** Opt-in: promote detected live file collisions to `conflict.detected`
 *  events (persisted, surfaced at every startup). Off by default so dogfood
 *  is not flooded with conflict events — the additionalContext warning alone
 *  satisfies the "surface a warning" requirement. */
function liveConflictEventsEnabled(): boolean {
  return process.env.MEMORIZE_LIVE_CONFLICT_EVENTS === '1';
}

// --- swappable delivery channel ---------------------------------------------

/**
 * A transport for live updates. Phase 2 ships the inline additionalContext
 * channel (renders the payload via the agent adapter); a future MCP /
 * file-watcher channel implements the same interface — push instead of
 * return — without touching delta-build.
 */
export interface LiveUpdateChannel {
  readonly name: string;
  deliver(update: LiveUpdate, ctx: { agent: AdapterAgent }): string | undefined;
}

// --- per-session watermark (meta table, one key per session) ----------------

function shareWatermarkKey(sessionId: string): string {
  return `cls_share_watermark:${sessionId}`;
}

export function readShareWatermark(
  projectId: string,
  sessionId: string,
): string | undefined {
  const row = getDb(projectId)
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get(shareWatermarkKey(sessionId)) as { value: string } | undefined;
  return row?.value;
}

export function writeShareWatermark(
  projectId: string,
  sessionId: string,
  eventId: string,
): void {
  getDb(projectId)
    .prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(shareWatermarkKey(sessionId), eventId);
}

export function deleteShareWatermark(
  projectId: string,
  sessionId: string,
): void {
  getDb(projectId)
    .prepare('DELETE FROM meta WHERE key = ?')
    .run(shareWatermarkKey(sessionId));
}

/**
 * Defensive cleanup: remove any `cls_share_watermark:*` rows whose session is
 * no longer present in the sessions projection (crashed sessions whose
 * watermark was never deleted). Bounds meta-table growth to live sessions.
 * Best-effort — never throws into the caller.
 */
export function sweepOrphanShareWatermarks(
  projectId: string,
  liveSessionIds: ReadonlySet<string>,
): void {
  try {
    const db = getDb(projectId);
    const rows = db
      .prepare("SELECT key FROM meta WHERE key LIKE 'cls_share_watermark:%'")
      .all() as Array<{ key: string }>;
    const stale = rows
      .map((r) => r.key)
      .filter((key) => !liveSessionIds.has(key.slice('cls_share_watermark:'.length)));
    if (stale.length === 0) return;
    const del = db.prepare('DELETE FROM meta WHERE key = ?');
    db.transaction(() => {
      for (const key of stale) del.run(key);
    })();
  } catch {
    // cleanup is best-effort
  }
}

// --- helpers ----------------------------------------------------------------

function currentMaxEventId(projectId: string): string | undefined {
  const row = getDb(projectId)
    .prepare('SELECT id FROM events ORDER BY seq DESC LIMIT 1')
    .get() as { id: string } | undefined;
  return row?.id;
}

/** Normalize a file path for cross-session equality (case-insensitive,
 *  resolved against the session cwd so relative/absolute forms compare equal
 *  — robust enough for a heuristic collision check on Windows + POSIX). */
export function normalizeFilePath(filePath: string, cwd: string): string {
  return path.resolve(cwd, filePath).toLowerCase();
}

const WRITE_SUMMARY_PATTERN = /^(?:Write|Edit|MultiEdit):\s*(.+)$/;

/** Prefer the structured `filePath`; fall back to parsing legacy summaries. */
function observationFilePath(obs: Observation): string | undefined {
  if (obs.filePath) return obs.filePath;
  if (obs.summary) {
    const match = WRITE_SUMMARY_PATTERN.exec(obs.summary);
    if (match) return match[1]!.trim();
  }
  return undefined;
}

function siblingActor(
  projectId: string,
  sessionId: string | undefined,
  fallbackActor: string,
): string {
  if (!sessionId) return fallbackActor;
  try {
    return getSession(projectId, sessionId)?.actor ?? fallbackActor;
  } catch {
    return fallbackActor;
  }
}

/** Normalized recent file paths this session touched (collision input). */
function recentSelfFilePaths(
  projectId: string,
  selfSessionId: string,
  cwd: string,
  nowMs: number,
): Set<string> {
  const sinceIso = new Date(
    nowMs - SELF_FILE_TOUCH_MAX_AGE_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const observations = listRecentObservations(projectId, {
    sessionId: selfSessionId,
    limit: SELF_FILE_TOUCH_LIMIT,
    sinceIso,
  });
  const paths = new Set<string>();
  for (const obs of observations) {
    const filePath = observationFilePath(obs);
    if (filePath) paths.add(normalizeFilePath(filePath, cwd));
  }
  return paths;
}

// --- delta build ------------------------------------------------------------

/**
 * Build the live-update delta for one session: events SIBLING sessions
 * appended since `sinceEventId`, self-filtered, ranked, and capped. Reads the
 * raw event log (not the observations projection) because the watermark is an
 * event id and `readEventsSince` is exactly id/seq-keyed — and it picks up
 * `memory.consolidated` in the same scan.
 */
export async function buildLiveUpdate(params: {
  projectId: string;
  selfSessionId: string | undefined;
  sinceEventId: string | undefined;
  selfRecentFilePaths: ReadonlySet<string>;
  cwd: string;
}): Promise<LiveUpdate> {
  const empty: LiveUpdate = {
    observations: [],
    memories: [],
    conflicts: [],
    newWatermarkEventId: params.sinceEventId,
    hasContent: false,
  };
  // Without a self session id we cannot self-filter, so we never inject (would
  // risk echoing the session's own events back to it). Common on codex.
  if (!params.selfSessionId) return empty;

  const all = await readEventsSince(params.projectId, params.sinceEventId);
  if (all.length === 0) return empty;

  const fullWindowLastId = all[all.length - 1]!.id;
  // Hard window cap: if the watermark is very stale, only process the most
  // recent slice for content but still jump the watermark to head.
  const scanned =
    all.length > MAX_DELTA_SCAN ? all.slice(all.length - MAX_DELTA_SCAN) : all;

  const observations: SiblingObservationItem[] = [];
  const memories: SiblingMemoryItem[] = [];

  for (const event of scanned) {
    if (event.type === 'observation.captured') {
      const obs = event.payload as Observation;
      if (obs.sessionId === params.selfSessionId) continue; // self-filter
      observations.push({
        sessionId: obs.sessionId ?? '(unknown)',
        actor: siblingActor(params.projectId, obs.sessionId, event.actor),
        signal: obs.signal,
        ...(obs.toolName ? { toolName: obs.toolName } : {}),
        ...(obs.summary ? { summary: obs.summary } : {}),
        createdAt: obs.createdAt,
      });
    } else if (event.type === 'memory.consolidated') {
      const memory = event.payload as ConsolidatedMemory;
      if (memory.sessionId === params.selfSessionId) continue; // self-filter
      memories.push({
        kind: memory.kind,
        text: memory.text,
        salience: memory.salience,
        ...(memory.sessionId ? { sessionId: memory.sessionId } : {}),
        actor: siblingActor(params.projectId, memory.sessionId, event.actor),
        createdAt: memory.createdAt,
      });
    }
  }

  // File-collision detection: a sibling write to a path this session also
  // touched recently. One warning per file (dedup), highest signal first.
  const conflicts: FileConflictWarning[] = [];
  const seenConflictPaths = new Set<string>();
  for (const event of scanned) {
    if (event.type !== 'observation.captured') continue;
    const obs = event.payload as Observation;
    if (obs.sessionId === params.selfSessionId) continue;
    if (obs.signal !== 'write-tool') continue;
    const rawPath = observationFilePath(obs);
    if (!rawPath) continue;
    const normalized = normalizeFilePath(rawPath, params.cwd);
    if (!params.selfRecentFilePaths.has(normalized)) continue;
    if (seenConflictPaths.has(normalized)) continue;
    seenConflictPaths.add(normalized);
    conflicts.push({
      filePath: rawPath,
      siblingSessionId: obs.sessionId ?? '(unknown)',
      siblingActor: siblingActor(params.projectId, obs.sessionId, event.actor),
      ...(obs.summary ? { siblingSummary: obs.summary } : {}),
    });
  }

  // Rank + cap. Conflicts are highest signal; memories by salience; raw
  // observations newest first. The char budget is applied later at render.
  observations.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  memories.sort((a, b) => b.salience - a.salience);

  const cappedObservations = observations.slice(0, MAX_LIVE_OBSERVATIONS);
  const cappedMemories = memories.slice(0, MAX_LIVE_MEMORIES);
  const cappedConflicts = conflicts.slice(0, MAX_LIVE_CONFLICTS);
  const hasContent =
    cappedObservations.length + cappedMemories.length + cappedConflicts.length >
    0;

  return {
    observations: cappedObservations,
    memories: cappedMemories,
    conflicts: cappedConflicts,
    newWatermarkEventId: fullWindowLastId,
    hasContent,
  };
}

// --- conflict promotion (opt-in) --------------------------------------------

async function maybePromoteConflicts(
  projectId: string,
  agent: AdapterAgent,
  selfScopeId: string,
  conflicts: FileConflictWarning[],
): Promise<void> {
  if (!liveConflictEventsEnabled() || conflicts.length === 0) return;
  // Dedup against already-open conflicts covering the same file path.
  const openPaths = new Set(
    listOpenConflicts(projectId).map((c) => c.fieldPath),
  );
  const fresh = conflicts.filter((c) => !openPaths.has(c.filePath));
  if (fresh.length === 0) return;
  for (const warning of fresh) {
    const conflict = createConflict({
      projectId,
      scopeType: 'task',
      scopeId: selfScopeId,
      fieldPath: warning.filePath,
      leftVersion: `session ${selfScopeId}`,
      rightVersion: `session ${warning.siblingSessionId} (${warning.siblingActor})`,
      conflictType: 'ownership',
    });
    await appendEvent({
      type: 'conflict.detected',
      projectId,
      scopeType: 'project',
      scopeId: projectId,
      actor: agent,
      payload: conflict,
    });
  }
  // Conflicts are not FTS-indexed entities, so skip the reindex.
  await rebuildProjectProjection(projectId, { reindexSearch: false });
}

// --- channels ---------------------------------------------------------------

export const postToolUseChannel: LiveUpdateChannel = {
  name: 'post-tool-use',
  deliver(update, ctx) {
    if (!update.hasContent) return undefined;
    return adapterRegistry[ctx.agent].renderLiveUpdate(update);
  },
};

// --- orchestrator (PostToolUse entry point) ---------------------------------

/**
 * Compose the live update for the current session and return the rendered
 * additionalContext string (or undefined for a no-op). Orchestrates: resolve
 * self session → read watermark → cold-start seed → build delta → advance
 * watermark (always) → guard on content → optional conflict promotion →
 * channel deliver. NEVER throws into the hook (caller wraps in try/catch too).
 */
export async function composeLiveUpdate(params: {
  projectId: string;
  agent: AdapterAgent;
  cwd: string;
  channel?: LiveUpdateChannel;
}): Promise<string | undefined> {
  const channel = params.channel ?? postToolUseChannel;
  const sessionCtx = await resolveSessionContext(params.cwd, {
    debugLabel: 'hook-live-share',
  });
  const selfSessionId = sessionCtx.sessionId;
  if (!selfSessionId) return undefined; // cannot self-filter → no-op

  const sinceEventId = readShareWatermark(params.projectId, selfSessionId);

  // Cold start: no watermark yet. Seed it to the current head and stay silent
  // this turn so the first injection is tied to genuine sibling activity (not
  // a dump of the whole project history).
  if (sinceEventId === undefined) {
    const head = currentMaxEventId(params.projectId);
    if (head) writeShareWatermark(params.projectId, selfSessionId, head);
    return undefined;
  }

  const nowMs = Date.parse(nowIso());
  const selfRecentFilePaths = recentSelfFilePaths(
    params.projectId,
    selfSessionId,
    params.cwd,
    nowMs,
  );

  const update = await buildLiveUpdate({
    projectId: params.projectId,
    selfSessionId,
    sinceEventId,
    selfRecentFilePaths,
    cwd: params.cwd,
  });

  // Advance the watermark over the entire scanned window (even when capped or
  // empty) so the same window is never re-read → no duplicate injection.
  if (
    update.newWatermarkEventId &&
    update.newWatermarkEventId !== sinceEventId
  ) {
    writeShareWatermark(
      params.projectId,
      selfSessionId,
      update.newWatermarkEventId,
    );
  }

  if (!update.hasContent) return undefined; // watermark guard

  await maybePromoteConflicts(
    params.projectId,
    params.agent,
    sessionCtx.taskId ?? selfSessionId,
    update.conflicts,
  );

  return channel.deliver(update, { agent: params.agent });
}
