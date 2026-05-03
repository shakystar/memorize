import fs from 'node:fs/promises';

import type { AdapterAgent } from '../adapters/index.js';
import { ACTOR_NEXT_AGENT } from '../domain/common.js';
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
import { createCheckpoint, createHandoff } from './task-service.js';

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
  sessionId?: string;
}

interface StopPayload {
  lastAssistantMessage?: string;
  sessionId?: string;
}

function parsePostCompactPayload(raw: string | undefined): PostCompactPayload {
  const obj = parseJsonObject(raw);
  const result: PostCompactPayload = {};
  const compactSummary = readStringField(obj, 'compact_summary');
  if (compactSummary !== undefined) {
    result.compactSummary = compactSummary;
  }
  const sessionId = readStringField(obj, 'session_id');
  if (sessionId !== undefined) {
    result.sessionId = sessionId;
  }
  return result;
}

function parseStopPayload(raw: string | undefined): StopPayload {
  const obj = parseJsonObject(raw);
  const result: StopPayload = {};
  const lastAssistantMessage = readStringField(obj, 'last_assistant_message');
  if (lastAssistantMessage !== undefined) {
    result.lastAssistantMessage = lastAssistantMessage;
  }
  const sessionId = readStringField(obj, 'session_id');
  if (sessionId !== undefined) {
    result.sessionId = sessionId;
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
  const sessionId =
    payload.sessionId ?? (await getCurrentSessionId(ctx.cwd));
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

const handleStop: HookHandler = async (ctx) => {
  const payload = parseStopPayload(ctx.rawPayload);
  // Same Gap A fix as PostCompact: hand off the task this session
  // claimed, not "whatever project.activeTaskIds[0] happens to be."
  const activeTaskId =
    (await getCurrentSessionTaskId(ctx.cwd)) ??
    (await resolveActiveTaskId(ctx.projectId));
  // Hook payloads include the agent's own session_id. Pass it through
  // so endSession resolves correctly even when env/tty disambiguation
  // would have failed (the rc.2 dogfood found Claude's Stop killing
  // the most-recent codex session via the now-removed fallback).
  const endOpts = payload.sessionId
    ? { sessionId: payload.sessionId }
    : {};

  if (!activeTaskId) {
    await endSession(ctx.cwd, endOpts);
    return JSON.stringify({
      systemMessage:
        'memorize: session ended (no active task, skipped auto-handoff)',
    });
  }

  const summary =
    prepareHookText(
      payload.lastAssistantMessage,
      'hook.Stop.last_assistant_message',
    ) ?? 'No assistant message captured';
  const agentDisplayName = ctx.agent === 'claude' ? 'Claude' : 'Codex';
  const handoff = await createHandoff({
    projectId: ctx.projectId,
    taskId: activeTaskId,
    fromActor: ctx.agent,
    toActor: ACTOR_NEXT_AGENT,
    summary,
    nextAction: `Continue from the latest ${agentDisplayName} output.`,
  });
  await endSession(ctx.cwd, endOpts);

  return JSON.stringify({
    systemMessage: `memorize: handoff ${handoff.id} recorded`,
  });
};

// Empty `{}` keeps Claude Code / codex schema validators happy when memorize
// has nothing to contribute (PreCompact, PreToolUse, etc.).
const EMPTY_HOOK_RESULT = JSON.stringify({});

const claudeHookHandlers: Record<string, HookHandler> = {
  SessionStart: handleSessionStart,
  PostCompact: handlePostCompact,
  Stop: handleStop,
};

const codexHookHandlers: Record<string, HookHandler> = {
  SessionStart: handleSessionStart,
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
