import fs from 'node:fs/promises';

import {
  detectInjectionMarkers,
  MAX_HOOK_CONTENT_LENGTH,
  truncateContent,
  warnInjectionMarkers,
} from '../shared/content-safety.js';
import { composeStartupContext } from './launch-service.js';
import { getBoundProjectId, resolveActiveTaskId } from './project-service.js';
import {
  SESSION_ENV_VAR,
  endSession,
  getCurrentSessionId,
  startSession,
} from './session-service.js';
import { setupProject } from './setup-service.js';
import { createCheckpoint, createHandoff } from './task-service.js';

async function ensureProjectId(cwd: string): Promise<string> {
  const existingProjectId = await getBoundProjectId(cwd);
  if (existingProjectId) {
    return existingProjectId;
  }

  const setup = await setupProject(cwd);
  return setup.project.id;
}

async function persistEnvFile(
  targetPath: string,
  entries: Record<string, string>,
): Promise<void> {
  const lines = Object.entries(entries).map(
    ([key, value]) => `${key}=${JSON.stringify(value)}`,
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

async function handleSessionStart(params: {
  projectId: string;
  agent: 'claude' | 'codex';
  cwd: string;
  envFile?: string;
}): Promise<string> {
  const { startupContext: additionalContext } = await composeStartupContext({
    agent: params.agent,
    cwd: params.cwd,
  });
  const sessionId = await startSession(params.cwd, params.agent);

  if (params.envFile) {
    await persistEnvFile(params.envFile, {
      MEMORIZE_PROJECT_ID: params.projectId,
      [SESSION_ENV_VAR]: sessionId,
    });
  }

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  });
}

async function handleStop(params: {
  projectId: string;
  agent: 'claude' | 'codex';
  cwd: string;
  rawPayload: string | undefined;
}): Promise<string> {
  const payload = parseStopPayload(params.rawPayload);
  const activeTaskId = await resolveActiveTaskId(params.projectId);

  if (!activeTaskId) {
    await endSession(params.cwd);
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
  const agentDisplayName = params.agent === 'claude' ? 'Claude' : 'Codex';
  const handoff = await createHandoff({
    projectId: params.projectId,
    taskId: activeTaskId,
    fromActor: params.agent,
    toActor: 'next-agent',
    summary,
    nextAction: `Continue from the latest ${agentDisplayName} output.`,
  });
  await endSession(params.cwd);

  return JSON.stringify({
    systemMessage: `memorize: handoff ${handoff.id} recorded`,
  });
}

export async function runClaudeHook(params: {
  eventName: string;
  cwd: string;
  stdinPayload?: string;
}): Promise<string> {
  const projectId = await ensureProjectId(params.cwd);

  if (params.eventName === 'SessionStart') {
    return handleSessionStart({
      projectId,
      agent: 'claude',
      cwd: params.cwd,
      ...(process.env.CLAUDE_ENV_FILE
        ? { envFile: process.env.CLAUDE_ENV_FILE }
        : {}),
    });
  }

  if (params.eventName === 'PostCompact') {
    const payload = parsePostCompactPayload(params.stdinPayload);
    const activeTaskId = await resolveActiveTaskId(projectId);
    const sessionId =
      payload.sessionId ?? (await getCurrentSessionId(params.cwd));
    const summary =
      prepareHookText(payload.compactSummary, 'hook.PostCompact.compact_summary') ??
      'Compact summary unavailable';
    const checkpoint = await createCheckpoint({
      projectId,
      sessionId,
      ...(activeTaskId ? { taskId: activeTaskId } : {}),
      summary,
    });

    // PostCompact / PreCompact / Stop do not accept a `hookSpecificOutput`
    // block in their return payload — Claude Code's schema validator
    // rejects any hook that emits one for these events. The valid shape
    // is only the top-level fields (continue, systemMessage, etc.). Use
    // `systemMessage` to surface the operation result to the user.
    return JSON.stringify({
      systemMessage: `memorize: checkpoint ${checkpoint.id} recorded`,
    });
  }

  if (params.eventName === 'Stop') {
    return handleStop({
      projectId,
      agent: 'claude',
      cwd: params.cwd,
      rawPayload: params.stdinPayload,
    });
  }

  // Default (including PreCompact): emit an empty object so Claude
  // Code's schema validator accepts it. `hookSpecificOutput` is only
  // defined for a small set of events (PreToolUse, UserPromptSubmit,
  // PostToolUse, SessionStart), so do not include it here.
  return JSON.stringify({});
}

export async function runCodexHook(params: {
  eventName: string;
  cwd: string;
  stdinPayload?: string;
}): Promise<string> {
  // Codex hooks are registered globally in ~/.codex/hooks.json, so every
  // codex session triggers them regardless of project. The handler must
  // no-op fast when the cwd does not resolve to a memorize-bound project
  // (via walk-up) so we do not pollute unrelated codex sessions. Note:
  // unlike runClaudeHook, we use getBoundProjectId — never ensureProjectId
  // — so memorize never auto-creates state from a codex hook.
  const projectId = await getBoundProjectId(params.cwd);
  if (!projectId) {
    return JSON.stringify({});
  }

  if (params.eventName === 'SessionStart') {
    return handleSessionStart({
      projectId,
      agent: 'codex',
      cwd: params.cwd,
    });
  }

  if (params.eventName === 'Stop') {
    return handleStop({
      projectId,
      agent: 'codex',
      cwd: params.cwd,
      rawPayload: params.stdinPayload,
    });
  }

  // PreToolUse / PostToolUse / UserPromptSubmit — not used yet.
  // Return empty object so codex's hook validator accepts the output.
  return JSON.stringify({});
}
