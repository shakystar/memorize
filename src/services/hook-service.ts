import fs from 'node:fs/promises';

import type { AdapterAgent } from '../adapters/index.js';
import {
  detectInjectionMarkers,
  MAX_HOOK_CONTENT_LENGTH,
  truncateContent,
  warnInjectionMarkers,
} from '../shared/content-safety.js';
import { composeStartupContext } from './startup-context-service.js';
import {
  ensureBoundProjectId,
  getBoundProjectId,
  resolveActiveTaskId,
} from './project-service.js';
import {
  SESSION_ENV_VAR,
  endSession,
  getCurrentSessionId,
  getCurrentSessionTaskId,
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

function parsePostCompactPayload(raw: string | undefined): PostCompactPayload {
  const obj = parseJsonObject(raw);
  const result: PostCompactPayload = {};
  const compactSummary = readStringField(obj, 'compact_summary');
  if (compactSummary !== undefined) {
    result.compactSummary = compactSummary;
  }
  return result;
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
  // Order matters: composeStartupContext must run BEFORE startSession so
  // the new session is not yet in the projection when otherActiveTasks is
  // computed. Reversing this would make every starting session see itself
  // as a competing other-active-task.
  const composed = await composeStartupContext({
    agent: ctx.agent,
    cwd: ctx.cwd,
  });
  const sessionId = await startSession(ctx.cwd, {
    actor: ctx.agent,
    projectId: ctx.projectId,
    ...(composed.taskId ? { taskId: composed.taskId } : {}),
  });
  const additionalContext = composed.startupContext;

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
  // Prefer the task this session itself claimed at SessionStart over
  // project.activeTaskIds[0]. The naive fallback was Gap A in the rc.3
  // dogfood: it attached every checkpoint to whichever task happened to
  // be first in the project's active list, even if the calling session
  // was working on something else entirely.
  const activeTaskId =
    (await getCurrentSessionTaskId(ctx.cwd)) ??
    (await resolveActiveTaskId(ctx.projectId));
  // payload.sessionId is the AGENT's own session id (Claude UUID, Codex
  // turn id) — a different ID space from memorize's session_xxx. Using
  // it would mis-attribute the checkpoint. Always resolve via env/tty
  // (now reliable post Gap-B fix).
  const sessionId = await getCurrentSessionId(ctx.cwd);
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
  // Claude Code's SessionEnd fires regardless of how the session
  // terminated (clean /exit, Ctrl+C, terminal close — see hook docs
  // `reason` field: clear/resume/logout/prompt_input_exit/other).
  // Best-effort cleanup: write session.completed and unlink the cwd
  // pointer for whichever session this hook resolves to via env/tty.
  // If the resolution misses (e.g. env propagation lost), the session
  // stays as 'active' until the next reapStaleSessions sweep abandons
  // it — graceful degradation, not data loss.
  await endSession(ctx.cwd);
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
