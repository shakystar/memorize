import fs from 'node:fs/promises';

import type { AdapterAgent } from '../adapters/index.js';
import {
  detectInjectionMarkers,
  MAX_HOOK_CONTENT_LENGTH,
  truncateContent,
  warnInjectionMarkers,
} from '../shared/content-safety.js';
import { findAncestorPidByName } from '../shared/process-tree.js';
import { SESSION_ENV_VAR } from '../storage/cwd-session-store.js';
import { withFileLock } from '../storage/file-lock.js';
import { getProjectRoot } from '../storage/path-resolver.js';
import path from 'node:path';
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
  endSession,
  getCurrentSessionId,
  resumeSession,
  startSession,
} from './session-service.js';
import { createCheckpoint } from './task-service.js';

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
    parsed = JSON.parse(raw);
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

interface PostCompactPayload {
  compactSummary?: string;
}

interface IdentityPayload {
  agentSessionId?: string;
}

function parsePostCompactPayload(raw: string | undefined): PostCompactPayload {
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
function parseIdentityPayload(raw: string | undefined): IdentityPayload {
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

const handleSessionStart: HookHandler = async (ctx) => {
  const identity = parseIdentityPayload(ctx.rawPayload);
  // Walk up from this hook subprocess to find the agent's pid. Stored
  // on the pointer so the picker can later detect "agent process
  // exited but the pointer was never reaped" without changing the
  // session's status.
  const agentPid = process.ppid
    ? findAncestorPidByName({
        startPid: process.ppid,
        targetNames: ['claude', 'codex'],
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
    const composed = await composeStartupContext({
      agent: ctx.agent,
      cwd: ctx.cwd,
      selfSessionId: sessionId,
    });
    void resumedTaskId;
    additionalContext = composed.startupContext;
  } else {
    const claimed = await withFileLock(
      path.join(getProjectRoot(ctx.projectId), 'locks'),
      'session-start',
      async () => {
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
  const sessionCtx = await resolveSessionContext(ctx.cwd);
  const activeTaskId =
    sessionCtx.taskId ?? (await resolveActiveTaskId(ctx.projectId));
  const sessionId = sessionCtx.sessionId ?? (await getCurrentSessionId(ctx.cwd));
  const summary =
    prepareHookText(payload.compactSummary, 'hook.PostCompact.compact_summary') ??
    'Compact summary unavailable';
  const checkpoint = await createCheckpoint({
    projectId: ctx.projectId,
    sessionId,
    ...(activeTaskId ? { taskId: activeTaskId } : {}),
    summary,
  });

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
  // exposes (clean /exit, Ctrl+C twice, terminal close — see hook
  // docs `reason` field). Resolution chain, in priority order:
  //
  //   1. Map by payload.session_id → cwd pointer's stored
  //      agentSessionId. This is the only reliable path because
  //      Claude does NOT propagate MEMORIZE_SESSION_ID into the
  //      SessionEnd subprocess env (verified empirically — the
  //      subprocess starts with a different env than tool/Bash
  //      subprocesses do, despite the docs implying otherwise).
  //   2. Fall back to env/tty resolution via endSession() with no
  //      explicit sessionId. Mostly a safety net for cases where the
  //      agent payload didn't carry an id we recognized.
  //
  // If both miss, the session stays 'active' until the next
  // reapStaleSessions sweep abandons it — graceful degradation, not
  // data loss.
  const identity = parseIdentityPayload(ctx.rawPayload);
  let resolvedSessionId: string | undefined;
  if (identity.agentSessionId) {
    const match = await resolveByAgentSessionId(
      ctx.cwd,
      identity.agentSessionId,
    );
    if (match.sessionId) resolvedSessionId = match.sessionId;
  }
  await endSession(
    ctx.cwd,
    resolvedSessionId ? { sessionId: resolvedSessionId } : {},
  );
  return JSON.stringify({
    systemMessage: 'memorize: session ended',
  });
};

// Empty `{}` keeps Claude Code / codex schema validators happy when memorize
// has nothing to contribute (PreCompact, PreToolUse, etc.).
const EMPTY_HOOK_RESULT = JSON.stringify({});

const claudeHookHandlers: Record<string, HookHandler> = {
  SessionStart: handleSessionStart,
  PostCompact: handlePostCompact,
  SessionEnd: handleSessionEnd,
  Stop: handleStop,
};

const codexHookHandlers: Record<string, HookHandler> = {
  SessionStart: handleSessionStart,
  // Codex has no SessionEnd hook (verified against
  // developers.openai.com/codex/hooks 2026-05). Codex sessions get
  // cleaned up entirely via reapStaleSessions — either on the next
  // codex SessionStart in the same cwd or via `memorize session reap`.
  Stop: handleStop,
};

export async function runClaudeHook(params: {
  eventName: string;
  cwd: string;
  stdinPayload?: string;
}): Promise<string> {
  const projectId = await ensureBoundProjectId(params.cwd);
  const handler = claudeHookHandlers[params.eventName];
  if (!handler) return EMPTY_HOOK_RESULT;
  return handler({
    projectId,
    agent: 'claude',
    cwd: params.cwd,
    rawPayload: params.stdinPayload,
  });
}

export async function runCodexHook(params: {
  eventName: string;
  cwd: string;
  stdinPayload?: string;
}): Promise<string> {
  // Codex hooks live globally in ~/.codex/hooks.json so every codex
  // session fires them. Bail fast when cwd is not bound to memorize.
  // Unlike runClaudeHook we use getBoundProjectId — never auto-create
  // state from a codex hook.
  const projectId = await getBoundProjectId(params.cwd);
  if (!projectId) return EMPTY_HOOK_RESULT;

  const handler = codexHookHandlers[params.eventName];
  if (!handler) return EMPTY_HOOK_RESULT;
  return handler({
    projectId,
    agent: 'codex',
    cwd: params.cwd,
    rawPayload: params.stdinPayload,
  });
}
