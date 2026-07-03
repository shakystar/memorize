import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { AdapterAgent } from '../adapters/index.js';
import {
  type HarnessId,
  getHarness,
  runtimeHookEvents,
} from '../harness/registry.js';
import {
  detectInjectionMarkers,
  MAX_HOOK_CONTENT_LENGTH,
  truncateContent,
  warnInjectionMarkers,
} from '../shared/content-safety.js';
import { findAncestorPidByName } from '../shared/process-tree.js';
import { hasUnmigratedNdjson } from './migrate-service.js';
import { SESSION_ENV_VAR } from '../storage/cwd-session-store.js';
import { getDb } from '../storage/db.js';
import { withFileLock } from '../storage/file-lock.js';
import { getProjectRoot } from '../storage/path-resolver.js';
import path from 'node:path';
import { autoPull, autoPush } from './auto-sync-service.js';
import { captureObservation } from './capture-service.js';
import {
  type ConsolidateBoundary,
  SUPPRESS_HOOKS_ENV_VAR,
  consolidate,
  shouldTriggerThresholdConsolidate,
} from './consolidate-service.js';
import { composeLiveUpdate } from './realtime-share-service.js';
import { composeStartupContext } from './startup-context-service.js';
import {
  ensureBoundProjectId,
  getBoundProjectId,
  resolveActiveTaskId,
} from './project-service.js';
import {
  resolveByAgentSessionId,
  resolveSessionContext,
} from './session-context.js';
import {
  pauseSession,
  getCurrentSessionId,
  resumeSession,
  startSession,
} from './session-service.js';
import { createCheckpoint } from './task-service.js';
import { getUpdateNotice } from './update-service.js';

interface HookContext {
  projectId: string;
  agent: AdapterAgent;
  cwd: string;
  rawPayload: string | undefined;
}

type HookHandler = (ctx: HookContext) => Promise<string>;

async function persistEnvFile(
  targetPath: string,
  entries: Record<string, string>,
): Promise<void> {
  // CLAUDE_ENV_FILE points at a `.sh` script that Claude sources — not a
  // dotenv-style file. Without `export` the assignments stay shell-local
  // and never reach the spawned `claude` subprocess (or its tool calls).
  // Discovered during the rc.4 telemetry investigation: hooks were firing
  // but MEMORIZE_SESSION_ID was missing from every Bash subprocess.
  const lines = Object.entries(entries).map(
    ([key, value]) => `export ${key}=${JSON.stringify(value)}`,
  );
  await fs.writeFile(targetPath, `${lines.join('\n')}\n`, 'utf8');
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    // Cursor pipes hook payloads as UTF-8 WITH a BOM; JSON.parse rejects a
    // leading U+FEFF, which would silently drop every payload (no capture,
    // no session-id linking). Strip it before parsing.
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    process.stderr.write('WARN: hook stdin is not valid JSON; ignoring\n');
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    process.stderr.write('WARN: hook stdin is not a JSON object; ignoring\n');
    return {};
  }
  return parsed as Record<string, unknown>;
}

function readStringField(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = obj[key];
  return typeof value === 'string' ? value : undefined;
}

export function isCursorOriginPayload(raw: string | undefined): boolean {
  const obj = parseJsonObject(raw);
  return (
    typeof obj.cursor_version === 'string' ||
    (Array.isArray(obj.workspace_roots) &&
      (typeof obj.conversation_id === 'string' ||
        typeof obj.generation_id === 'string' ||
        typeof obj.session_id === 'string'))
  );
}

function effectiveHookAgent(
  harnessId: HarnessId,
  rawPayload: string | undefined,
): AdapterAgent {
  if (harnessId !== 'cursor' && isCursorOriginPayload(rawPayload)) {
    return 'cursor';
  }
  return harnessId;
}

function hookPayloadHash(raw: string | undefined): string {
  return createHash('sha256')
    .update(raw?.replace(/^\uFEFF/, '') ?? '')
    .digest('hex')
    .slice(0, 32);
}

function cursorBoundarySourceHookId(
  ctx: HookContext,
  handlerKey: string,
): string | undefined {
  if (ctx.agent !== 'cursor' || !isCursorOriginPayload(ctx.rawPayload)) {
    return undefined;
  }
  const obj = parseJsonObject(ctx.rawPayload);
  const agentSessionId = readStringField(obj, 'session_id') ?? 'no-session';
  const generationId = readStringField(obj, 'generation_id');
  const toolUseId = readStringField(obj, 'tool_use_id');
  const transcriptPath = readStringField(obj, 'transcript_path');
  const stablePart = toolUseId ?? generationId ?? transcriptPath ?? hookPayloadHash(ctx.rawPayload);
  return `cursor:${handlerKey}:${agentSessionId}:${stablePart}`;
}

function findCheckpointIdBySourceHookId(
  projectId: string,
  sourceHookId: string,
): string | undefined {
  const row = getDb(projectId)
    .prepare(
      `SELECT id
         FROM checkpoints
        WHERE json_extract(data, '$.sourceHookId') = ?
        LIMIT 1`,
    )
    .get(sourceHookId) as { id: string } | undefined;
  return row?.id;
}

export interface PostCompactPayload {
  compactSummary?: string;
}

export interface IdentityPayload {
  agentSessionId?: string;
}

export function parsePostCompactPayload(raw: string | undefined): PostCompactPayload {
  const obj = parseJsonObject(raw);
  const result: PostCompactPayload = {};
  const compactSummary = readStringField(obj, 'compact_summary');
  if (compactSummary !== undefined) {
    result.compactSummary = compactSummary;
  }
  return result;
}

/** Pulls the agent's own session id out of any hook payload that
 *  carries one. SessionStart, SessionEnd, Stop, and PostCompact all
 *  include it under `session_id`. We use it as a stable handle to the
 *  calling session so later events can look up what SessionStart
 *  claimed even when env propagation fails. */
export function parseIdentityPayload(raw: string | undefined): IdentityPayload {
  const obj = parseJsonObject(raw);
  const agentSessionId = readStringField(obj, 'session_id');
  return agentSessionId ? { agentSessionId } : {};
}

function prepareHookText(
  raw: string | undefined,
  field: string,
): string | undefined {
  if (raw === undefined) return undefined;
  const truncated = truncateContent(raw, field, MAX_HOOK_CONTENT_LENGTH);
  warnInjectionMarkers(detectInjectionMarkers(truncated, field));
  return truncated;
}

/**
 * The transcript path a boundary hook (SessionEnd / PreCompact / SessionStart)
 * carries in its payload (#99 cat-1). Lets consolidation read the conversation
 * of a session that captured zero observations — there is no observation to
 * carry the path otherwise. Best-effort: any parse failure means "unknown".
 */
function transcriptPathFromPayload(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const obj = JSON.parse(raw.replace(/^\uFEFF/, '')) as Record<string, unknown>;
    return typeof obj.transcript_path === 'string' ? obj.transcript_path : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Boundary consolidation attempt — NEVER fails the hook. A failure (LLM
 * timeout, lock contention, mid-write kill) leaves the watermark behind,
 * and the next boundary — including the next SessionStart's catch-up —
 * retries the same observation window (consolidate is watermark-idempotent).
 */
async function tryConsolidate(
  ctx: Pick<HookContext, 'projectId' | 'agent'>,
  sessionId: string | undefined,
  boundary: ConsolidateBoundary,
  transcriptPath?: string,
): Promise<void> {
  try {
    await consolidate({
      projectId: ctx.projectId,
      actor: ctx.agent,
      boundary,
      ...(sessionId ? { sessionId } : {}),
      ...(transcriptPath ? { transcriptPath } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `WARN: memory consolidation deferred (${message}); will catch up at the next boundary\n`,
    );
  }
}

/** Escape hatch (#46): `MEMORIZE_CONSOLIDATE_INLINE=1` restores the old
 *  synchronous in-process boundary consolidation. Used by the test suite
 *  (vitest.config.ts) so boundary hooks keep deterministic, awaitable
 *  semantics, and available to users who prefer blocking boundaries. */
export const CONSOLIDATE_INLINE_ENV_VAR = 'MEMORIZE_CONSOLIDATE_INLINE';

/** Minimal child surface the detached spawn needs (test-fakeable). */
export interface DetachedChild {
  unref(): void;
}

/** Spawn seam (test-injectable; node:child_process spawn satisfies it). */
export type DetachedSpawnImpl = (
  command: string,
  args: string[],
  options: { cwd: string; detached: boolean; stdio: 'ignore'; windowsHide: boolean },
) => DetachedChild;

/**
 * #46 Part A — boundary consolidation as a DETACHED background child.
 * Hooks must return fast (SessionStart blocks the agent's startup; the
 * SessionEnd subprocess gets reaped as soon as Claude exits), so instead
 * of awaiting consolidate() in-process we spawn `memorize consolidate`
 * detached and return immediately. The child finds the bound project via
 * its cwd, takes the consolidate file lock, runs the full-length LLM
 * extraction, and autoPushes its own events. Failures of the child are
 * covered by the existing contract: the watermark only advances on
 * success, so the next boundary retries the window.
 *
 * The child must NOT get MEMORIZE_SUPPRESS_HOOKS — it is a CLI command,
 * not a hook, and it must stay free to spawn the #44 host-CLI extractor
 * (which sets that guard for ITS grandchild). Never throws into the hook.
 */
export async function spawnDetachedConsolidate(
  ctx: Pick<HookContext, 'projectId' | 'agent' | 'cwd'>,
  sessionId: string | undefined,
  boundary: ConsolidateBoundary,
  transcriptPath?: string,
  spawnImpl: DetachedSpawnImpl = spawn,
): Promise<void> {
  if (process.env[CONSOLIDATE_INLINE_ENV_VAR] === '1') {
    await tryConsolidate(ctx, sessionId, boundary, transcriptPath);
    return;
  }
  try {
    // dist layout: this module is dist/services/hook-service.js, so the
    // CLI entry is ../cli/index.js. (Running hooks straight from src via
    // tsx has no built entry — tests pin MEMORIZE_CONSOLIDATE_INLINE=1.)
    const cliEntry = fileURLToPath(new URL('../cli/index.js', import.meta.url));
    const child = spawnImpl(
      process.execPath,
      [
        cliEntry,
        'consolidate',
        ...(sessionId ? ['--session', sessionId] : []),
        // #51: tells the child which boundary spawned it, so the recorded
        // attempt is attributable. Telemetry only — never changes behavior.
        '--boundary',
        boundary,
        // #99 cat-1: hand the child the transcript so a conversation-only
        // session (zero observations) still has its conversation consolidated.
        ...(transcriptPath ? ['--transcript', transcriptPath] : []),
      ],
      {
        cwd: ctx.cwd,
        detached: true,
        stdio: 'ignore',
        // Windows: hides the console window of the detached consolidate process.
        windowsHide: true,
      },
    );
    child.unref();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `WARN: background consolidation not started (${message}); the next boundary retries the window\n`,
    );
  }
}

/** Suite-wide off-switch (vitest.config.ts) — mirrors CONSOLIDATE_INLINE. */
export const UPDATE_CHECK_DISABLED_ENV_VAR = 'MEMORIZE_UPDATE_CHECK_DISABLED';

/**
 * Session-start update notice (notify-only). Reads the LOCAL cache only;
 * when the cache is stale it fire-and-forgets a detached
 * `memorize update --check` to refresh it for a LATER session. Never
 * blocks, never auto-installs (a hook-timed npm install would race the
 * very hook files an update rewrites), never throws into the hook.
 */
export async function maybeNotifyUpdate(
  spawnImpl: DetachedSpawnImpl = spawn,
): Promise<string | undefined> {
  if (process.env[UPDATE_CHECK_DISABLED_ENV_VAR] === '1') return undefined;
  try {
    const { notice, shouldCheck } = await getUpdateNotice();
    if (shouldCheck) {
      const cliEntry = fileURLToPath(new URL('../cli/index.js', import.meta.url));
      const child = spawnImpl(process.execPath, [cliEntry, 'update', '--check'], {
        cwd: process.cwd(),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    }
    return notice;
  } catch {
    return undefined; // an update notice must never break session start
  }
}

const handleSessionStart: HookHandler = async (ctx) => {
  // Opening the DB runs only DDL migrations — a project upgraded from the
  // NDJSON era reads as an empty store until `memorize migrate` imports its
  // legacy event log. Warn loudly (does not block the session) so the user
  // does not mistake un-migrated memory for lost memory.
  if (await hasUnmigratedNdjson(ctx.projectId)) {
    process.stderr.write(
      'WARN: Legacy NDJSON event log detected but not yet migrated to SQLite. ' +
        'Run `memorize migrate` to import it.\n',
    );
  }

  // CLS catch-up: a SessionEnd whose subprocess was reaped (or a codex
  // session, which has no SessionEnd at all) may have left observations
  // unconsolidated. Runs as a DETACHED background child (#46) so startup
  // is never blocked on the extractor. Contract: the startup context
  // composed below may lag one window (the catch-up's memories land
  // seconds later); the PostToolUse live-update channel injects them
  // into the running session as soon as they exist.
  await spawnDetachedConsolidate(
    ctx,
    undefined,
    'session-start',
    transcriptPathFromPayload(ctx.rawPayload),
  );

  // P3-b: pull sibling-machine events BEFORE composing startup context so the
  // injected memories/tasks reflect the latest remote state. No-op + silent
  // unless this project has a persisted syncTransport; never throws.
  await autoPull(ctx.projectId);

  const identity = parseIdentityPayload(ctx.rawPayload);
  // Walk up from this hook subprocess to find the agent's pid. Stored
  // on the pointer so the picker can later detect "agent process
  // exited but the pointer was never reaped" without changing the
  // session's status.
  const agentPid = process.ppid
    ? await findAncestorPidByName({
        startPid: process.ppid,
        targetNames: ['claude', 'codex', 'cursor'],
      })
    : undefined;

  // Resume detection: Claude Code preserves its session UUID across
  // `claude --resume`. If we already have a cwd pointer with that
  // agentSessionId, the agent is re-attaching to the same memorize
  // session — reuse the pointer instead of minting a new one.
  // Preserves the "1 agent conversation = 1 memorize session"
  // invariant for users who routinely resume role-assigned sessions.
  let sessionId: string | undefined;
  let resumedTaskId: string | undefined;
  if (identity.agentSessionId) {
    const existing = await resolveByAgentSessionId(
      ctx.cwd,
      identity.agentSessionId,
      { debugLabel: 'hook-session-start-resume' },
    );
    if (existing.sessionId) {
      const reattached = await resumeSession(ctx.cwd, existing.sessionId, {
        ...(agentPid ? { agentPid } : {}),
      });
      if (reattached) {
        sessionId = existing.sessionId;
        resumedTaskId = existing.taskId;
      }
    }
  }

  // composeStartupContext must run BEFORE startSession so the new
  // session is not yet in the projection when otherActiveTasks is
  // computed. Reversing this would make every starting session see
  // itself as a competing other-active-task. (Resume path follows the
  // same rule — we passed selfSessionId through so the projection
  // picker hides the just-resumed session from its own context.)
  //
  // The picker view → startSession write must happen atomically per
  // project: rc.7 round-2 dogfood saw two SessionStart hooks fire
  // 32ms apart and both pickers saw the same active set, so both
  // newly-started sessions claimed the same task. The lock here
  // serializes that critical section across hook subprocesses.
  // Resume path skips the claim (no startSession call), so we only
  // need the lock when we're actually going to mint a new session.
  //
  // The composed startup context is what we hand back to the agent
  // as `additionalContext`, so it has to be computed in either path.
  let additionalContext: string;
  if (sessionId) {
    // Resume path: pin the previously-claimed task so the picker
    // doesn't hand back a different unclaimed task on reattach.
    // Without this pin the rc.11+Model-C dry-run showed codex
    // resume returning the wrong task in additionalContext (the
    // picker happily picked the next-best unclaimed candidate
    // because the resumed session was excluded from its own view).
    const composed = await composeStartupContext({
      agent: ctx.agent,
      cwd: ctx.cwd,
      selfSessionId: sessionId,
      ...(resumedTaskId ? { taskId: resumedTaskId } : {}),
    });
    additionalContext = composed.startupContext;
  } else {
    const claimed = await withFileLock(
      path.join(getProjectRoot(ctx.projectId), 'locks'),
      'session-start',
      async () => {
        if (identity.agentSessionId) {
          const existing = await resolveByAgentSessionId(
            ctx.cwd,
            identity.agentSessionId,
            { debugLabel: 'hook-session-start-lock-recheck' },
          );
          if (existing.sessionId) {
            const composed = await composeStartupContext({
              agent: ctx.agent,
              cwd: ctx.cwd,
              selfSessionId: existing.sessionId,
              ...(existing.taskId ? { taskId: existing.taskId } : {}),
            });
            return {
              sessionId: existing.sessionId,
              startupContext: composed.startupContext,
            };
          }
        }
        const composed = await composeStartupContext({
          agent: ctx.agent,
          cwd: ctx.cwd,
        });
        const newSessionId = await startSession(ctx.cwd, {
          actor: ctx.agent,
          projectId: ctx.projectId,
          ...(composed.taskId ? { taskId: composed.taskId } : {}),
          ...(identity.agentSessionId
            ? { agentSessionId: identity.agentSessionId }
            : {}),
          ...(agentPid ? { agentPid } : {}),
        });
        return { sessionId: newSessionId, startupContext: composed.startupContext };
      },
    );
    sessionId = claimed.sessionId;
    additionalContext = claimed.startupContext;
  }

  // Claude Code passes a writable env-file path so memorize can hand
  // back the new session id. Codex has no equivalent — only Claude
  // populates this env var.
  if (ctx.agent === 'claude' && process.env.CLAUDE_ENV_FILE) {
    await persistEnvFile(process.env.CLAUDE_ENV_FILE, {
      MEMORIZE_PROJECT_ID: ctx.projectId,
      [SESSION_ENV_VAR]: sessionId,
    });
  }

  const updateNotice = await maybeNotifyUpdate();
  if (updateNotice) {
    additionalContext = `${additionalContext}\n\n${updateNotice}`;
  }

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  });
};

const handlePostCompact: HookHandler = async (ctx) => {
  const payload = parsePostCompactPayload(ctx.rawPayload);
  // Single resolver call returns both the session id (for the
  // checkpoint attribution) and the session-claimed task id (for the
  // Gap A fix — never fall straight to project.activeTaskIds[0]).
  // payload.session_id from the agent is in a different ID space
  // (Claude UUID, codex session UUID) and is intentionally not
  // consulted here.
  const sessionCtx = await resolveSessionContext(ctx.cwd, {
    debugLabel: 'hook-post-compact',
  });
  const activeTaskId =
    sessionCtx.taskId ?? (await resolveActiveTaskId(ctx.projectId));
  const sessionId = sessionCtx.sessionId ?? (await getCurrentSessionId(ctx.cwd));
  const summary =
    prepareHookText(payload.compactSummary, 'hook.PostCompact.compact_summary') ??
    'Compact summary unavailable';
  const sourceHookId = cursorBoundarySourceHookId(ctx, 'PostCompact');
  const createOrReuseCheckpoint = async (): Promise<{
    id: string;
    created: boolean;
  }> => {
    if (sourceHookId) {
      const existingCheckpointId = findCheckpointIdBySourceHookId(
        ctx.projectId,
        sourceHookId,
      );
      if (existingCheckpointId) {
        return { id: existingCheckpointId, created: false };
      }
    }
    const checkpoint = await createCheckpoint({
      projectId: ctx.projectId,
      sessionId,
      ...(activeTaskId ? { taskId: activeTaskId } : {}),
      summary,
      ...(sourceHookId ? { sourceHookId } : {}),
    });
    return { id: checkpoint.id, created: true };
  };
  const checkpoint = sourceHookId
    ? await withFileLock(
        path.join(getProjectRoot(ctx.projectId), 'locks'),
        'cursor-post-compact',
        createOrReuseCheckpoint,
      )
    : await createOrReuseCheckpoint();

  // Compaction is a CLS boundary: consolidate the observation window that
  // is about to fall out of the agent's context — detached (#46), so the
  // hook returns immediately. The child autoPushes its own new events.
  if (checkpoint.created) {
    await spawnDetachedConsolidate(
      ctx,
      sessionId,
      'post-compact',
      transcriptPathFromPayload(ctx.rawPayload),
    );
  }

  // P3-b: propagate this boundary's capture events to siblings (background,
  // no-op unless syncTransport is configured; never throws).
  if (checkpoint.created) {
    await autoPush(ctx.projectId);
  }

  // PostCompact / PreCompact / Stop must NOT include `hookSpecificOutput`
  // — Claude Code's schema validator rejects it on these events. Top-level
  // fields like `systemMessage` are the only valid surface here.
  return JSON.stringify({
    systemMessage: `memorize: checkpoint ${checkpoint.id} recorded`,
  });
};

// β redesign: Stop fires per-turn (every assistant response end), NOT
// per-session. The rc.0..rc.4 design treated it as session-end, which
// caused per-turn auto-handoffs to accumulate (handoff = an intentional
// inter-agent baton-pass, not "the AI just spoke once") and per-turn
// session-completed events to fire (or fail to fire — rc.4 Gap D). The
// honest model: handoffs are agent-initiated (`memorize handoff
// create`), session lifecycle is owned by SessionStart + heartbeat +
// reapStaleSessions + (when available) the agent's SessionEnd hook.
// Stop now no-ops; we keep the handler so pre-β installs that still
// register Stop don't fail when the hook fires.
const handleStop: HookHandler = async () => EMPTY_HOOK_RESULT;

const handleSessionEnd: HookHandler = async (ctx) => {
  // Claude Code's SessionEnd fires on every termination path it
  // exposes (clean /exit, Ctrl+C twice, terminal close). We map the
  // payload's session_id to the cwd pointer via agentSessionId — the
  // only reliable path, since Claude does NOT propagate
  // MEMORIZE_SESSION_ID into the SessionEnd subprocess env
  // (empirically verified, despite the docs implying otherwise).
  //
  // We `pauseSession` rather than `endSession` here: marking the
  // session 'paused' keeps the cwd pointer on disk so a later
  // `claude --resume` can reattach via agentSessionId match. The
  // SessionStart resume path then transitions status back to 'active'
  // by emitting a session.resumed event. If the user never resumes,
  // the heartbeat-staleness reap sweep catches the paused session
  // exactly the way it would catch an active-but-stale one — no data
  // loss, just delayed cleanup.
  //
  // Codex has no SessionEnd hook event at all (its hook surface is
  // SessionStart / PreToolUse / PostToolUse / UserPromptSubmit /
  // Stop), so codex sessions skip pause entirely and rely on the
  // same reap path as the fallback above. The asymmetry is harmless:
  // `paused` and `active` are equivalent for the picker view and the
  // reap threshold.
  const identity = parseIdentityPayload(ctx.rawPayload);
  let resolvedSessionId: string | undefined;
  if (identity.agentSessionId) {
    const match = await resolveByAgentSessionId(
      ctx.cwd,
      identity.agentSessionId,
      { debugLabel: 'hook-session-end' },
    );
    if (match.sessionId) resolvedSessionId = match.sessionId;
  }
  await pauseSession(
    ctx.cwd,
    resolvedSessionId ? { sessionId: resolvedSessionId } : {},
  );

  // Session end is a CLS boundary too. Claude exits as soon as the hook
  // fires and reaps this subprocess — the DETACHED child (#46) survives
  // that reap and finishes the consolidation on its own. If the child
  // still dies mid-way, the watermark only advances on success and the
  // next SessionStart's catch-up redoes the window.
  await spawnDetachedConsolidate(
    ctx,
    resolvedSessionId,
    'session-end',
    transcriptPathFromPayload(ctx.rawPayload),
  );

  // P3-b: the session's final push rides the DETACHED consolidate child
  // above — `memorize consolidate` autoPushes unconditionally after its
  // extraction attempt, so an in-process push here is pure duplication.
  // It was also actively harmful: awaiting a network push kept this hook
  // alive past Claude's shutdown grace, so every exit with an HTTP
  // transport surfaced "SessionEnd hook failed: Hook cancelled" to the
  // user. If the child dies before its push lands, the next boundary /
  // sibling SessionStart pull converges (push is watermark-idempotent).
  // (Codex has no SessionEnd; its PostCompact + next SessionStart pull
  // cover the same ground.)

  return JSON.stringify({
    systemMessage: 'memorize: session paused (resumable)',
  });
};

// Empty `{}` keeps Claude Code / codex schema validators happy when memorize
// has nothing to contribute (PreCompact, PreToolUse, etc.).
const EMPTY_HOOK_RESULT = JSON.stringify({});

// CLS short-term capture + Phase 2 real-time share. Fires on every
// whitelisted tool use, so both halves must be cheap (rule filter + one
// append; a seq-keyed delta read — no LLM, no FTS reindex) and must NEVER
// fail the agent's tool flow — any error degrades to a no-op warn.
const handlePostToolUse: HookHandler = async (ctx) => {
  // 1. Capture this session's own observation (short-term layer).
  try {
    const observation = await captureObservation({
      projectId: ctx.projectId,
      agent: ctx.agent,
      cwd: ctx.cwd,
      rawPayload: ctx.rawPayload,
    });
    // Threshold boundary: when the un-consolidated backlog reaches
    // MEMORIZE_CONSOLIDATE_THRESHOLD mid-session, consolidate now instead
    // of waiting for the next lifecycle boundary (freshness + a bounded
    // crash-loss window). The should-check debounces per watermark, and
    // the spawn itself never throws into the hook.
    if (observation && shouldTriggerThresholdConsolidate(ctx.projectId)) {
      await spawnDetachedConsolidate(ctx, observation.sessionId, 'threshold');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`WARN: observation capture skipped (${message})\n`);
  }

  // 2. Real-time share: inject the delta from PARALLEL sessions, if any.
  // additionalContext IS injectable on PostToolUse (Claude Code); codex may
  // ignore it, which is a harmless no-op (capture above still ran). The
  // watermark guard inside composeLiveUpdate keeps this silent unless a
  // sibling session actually produced new events.
  try {
    const additionalContext = await composeLiveUpdate({
      projectId: ctx.projectId,
      agent: ctx.agent,
      cwd: ctx.cwd,
    });
    if (additionalContext) {
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext,
        },
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`WARN: live share skipped (${message})\n`);
  }
  return EMPTY_HOOK_RESULT;
};

// One handler per lifecycle event, shared across harnesses (the handlers are
// harness-agnostic). Which events a given harness actually dispatches is
// decided by `runtimeHookEvents(id)` from the registry — e.g. codex has no
// SessionEnd, so a SessionEnd fired under codex resolves to the empty result.
// Codex PostToolUse fires for Bash-like tools only today (known upstream
// issue); partial capture beats none. Stop is a kept no-op so pre-β installs
// that still register it don't error.
const sharedHookHandlers: Record<string, HookHandler> = {
  SessionStart: handleSessionStart,
  PostToolUse: handlePostToolUse,
  PostCompact: handlePostCompact,
  SessionEnd: handleSessionEnd,
  Stop: handleStop,
};

/**
 * Translate a canonical (Claude-shaped) handler result into the wire envelope a
 * harness expects. Identity for everyone whose descriptor leaves `injectionWire`
 * unset: Claude/Codex/Gemini consume the Claude shape directly, and ts-plugins
 * (opencode/pi) translate harness-side in the planted extension. The two
 * harnesses that read a DIFFERENT native field declare it via `injectionWire`:
 *   - 'context'            ⇒ hermes `{"context": "..."}` (its pre_llm_call
 *     injection channel; every other hook's stdout is ignored).
 *   - 'additional_context' ⇒ cursor `{"additional_context": "..."}` (sessionStart
 *     initial context + postToolUse after-result injection; snake_case + top-level).
 * For both, we pull `hookSpecificOutput.additionalContext` out of the canonical
 * shape and re-emit it under the native key, collapsing every other (non-context)
 * result to `{}`. Never throws: a parse failure degrades to the empty envelope.
 */
function renderHookWire(
  descriptor: ReturnType<typeof getHarness>,
  canonicalJson: string,
): string {
  const wireKey = descriptor.injectionWire;
  if (!wireKey) return canonicalJson;
  try {
    const parsed = JSON.parse(canonicalJson) as {
      hookSpecificOutput?: { additionalContext?: unknown };
    };
    const ctx = parsed.hookSpecificOutput?.additionalContext;
    if (typeof ctx === 'string' && ctx.length > 0) {
      return JSON.stringify({ [wireKey]: ctx });
    }
  } catch {
    // fall through to the empty envelope
  }
  return JSON.stringify({});
}

/**
 * Run a fired lifecycle hook for any registered harness. Replaces the old
 * per-harness `runClaudeHook`/`runCodexHook` (kept as thin wrappers): binding
 * policy (auto-create vs bail-if-unbound) and the handled-event set are read
 * from the harness descriptor, so adding a harness needs no new runner.
 */
export async function runHook(
  harnessId: HarnessId,
  params: { eventName: string; cwd: string; stdinPayload?: string },
): Promise<string> {
  // Recursion guard (#44): the boundary consolidator can spawn the host CLI
  // (claude -p / codex exec) as its extractor, and that child session fires
  // these very hooks. The extractor sets MEMORIZE_SUPPRESS_HOOKS in the child
  // env so its own invocation is never captured/consolidated
  // (consolidate → claude -p → SessionStart hook → consolidate → ...).
  if (process.env[SUPPRESS_HOOKS_ENV_VAR]) return EMPTY_HOOK_RESULT;

  // Binding policy per descriptor: claude auto-creates a binding; codex hooks
  // are global (fire in every cwd) so they bail fast when cwd is unbound,
  // never auto-creating state. Bind BEFORE the handled-event gate to preserve
  // the historical auto-bind side effect on claude.
  const descriptor = getHarness(harnessId);
  const effectiveAgent = effectiveHookAgent(harnessId, params.stdinPayload);
  const projectId = descriptor.autoBindProject
    ? await ensureBoundProjectId(params.cwd)
    : await getBoundProjectId(params.cwd);
  if (!projectId) return EMPTY_HOOK_RESULT;

  // Gate on the NATIVE fired event, then translate to the canonical handler
  // (identity for Claude/Codex; e.g. Gemini `AfterTool` → `PostToolUse`).
  if (!runtimeHookEvents(harnessId).includes(params.eventName)) {
    return EMPTY_HOOK_RESULT;
  }
  const handlerKey =
    descriptor.eventHandlerMap?.[params.eventName] ?? params.eventName;
  const handler = sharedHookHandlers[handlerKey];
  if (!handler) return EMPTY_HOOK_RESULT;

  // Once-per-session injection gate (hermes). Its SessionStart is wired to the
  // per-TURN `pre_llm_call`, so without a gate it would mint/re-inject every
  // turn. If a memorize session already exists for this agent session_id, the
  // conversation already carries turn-1's injected memory — return the empty
  // wire envelope and skip the handler entirely (no event-log churn, no
  // duplicate injection). Turn 1 finds no match and runs the full handler,
  // which mints the session stamped with this agentSessionId.
  if (descriptor.sessionStartPerTurn && handlerKey === 'SessionStart') {
    const { agentSessionId } = parseIdentityPayload(params.stdinPayload);
    if (agentSessionId) {
      const existing = await resolveByAgentSessionId(params.cwd, agentSessionId, {
        debugLabel: 'hook-session-start-per-turn-gate',
      });
      if (existing.sessionId) return renderHookWire(descriptor, EMPTY_HOOK_RESULT);
    }
  }

  const result = await handler({
    projectId,
    agent: effectiveAgent,
    cwd: params.cwd,
    rawPayload: params.stdinPayload,
  });
  return renderHookWire(descriptor, result);
}

export function runClaudeHook(params: {
  eventName: string;
  cwd: string;
  stdinPayload?: string;
}): Promise<string> {
  return runHook('claude', params);
}

export function runCodexHook(params: {
  eventName: string;
  cwd: string;
  stdinPayload?: string;
}): Promise<string> {
  return runHook('codex', params);
}
