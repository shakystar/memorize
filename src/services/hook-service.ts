import fs from 'node:fs/promises';

import {
  detectInjectionMarkers,
  MAX_HOOK_CONTENT_LENGTH,
  truncateContent,
  warnInjectionMarkers,
} from '../shared/content-safety.js';
import { prepareLaunch } from './launch-service.js';
import { getBoundProjectId, readProject } from './project-service.js';
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

async function resolveActiveTaskId(projectId: string): Promise<string | undefined> {
  const project = await readProject(projectId);
  return project?.activeTaskIds[0];
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

export async function runClaudeHook(params: {
  eventName: string;
  cwd: string;
  stdinPayload?: string;
}): Promise<string> {
  const projectId = await ensureProjectId(params.cwd);

  if (params.eventName === 'SessionStart') {
    const bootstrap = await prepareLaunch({
      agent: 'claude',
      cwd: params.cwd,
      passthroughArgs: [],
    });
    const additionalContext = bootstrap.startupContext;
    const sessionId = await startSession(params.cwd, 'claude');

    const envFile = process.env.CLAUDE_ENV_FILE;
    if (envFile) {
      await persistEnvFile(envFile, {
        MEMORIZE_PROJECT_ID: projectId,
        MEMORIZE_BOOTSTRAP_FILE: bootstrap.bootstrapFilePath,
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

    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostCompact',
        message: `Checkpoint recorded: ${checkpoint.id}`,
      },
    });
  }

  if (params.eventName === 'Stop') {
    const payload = parseStopPayload(params.stdinPayload);
    const activeTaskId = await resolveActiveTaskId(projectId);
    const sessionId =
      payload.sessionId ?? (await getCurrentSessionId(params.cwd));
    const summary =
      prepareHookText(
        payload.lastAssistantMessage,
        'hook.Stop.last_assistant_message',
      ) ?? 'No assistant message captured';
    const handoff = await createHandoff({
      projectId,
      taskId: activeTaskId ?? sessionId,
      fromActor: 'claude',
      toActor: 'next-agent',
      summary,
      nextAction: 'Continue from the latest Claude output.',
    });
    await endSession(params.cwd);

    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'Stop',
        message: `Handoff recorded: ${handoff.id}`,
      },
    });
  }

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: params.eventName,
    },
  });
}
