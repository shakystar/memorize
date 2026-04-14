import fs from 'node:fs/promises';

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
  const lines = Object.entries(entries).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  await fs.writeFile(targetPath, `${lines.join('\n')}\n`, 'utf8');
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
    const payload = JSON.parse(params.stdinPayload ?? '{}') as {
      compact_summary?: string;
      session_id?: string;
    };
    const activeTaskId = await resolveActiveTaskId(projectId);
    const sessionId =
      payload.session_id ?? (await getCurrentSessionId(params.cwd));
    const checkpoint = await createCheckpoint({
      projectId,
      sessionId,
      ...(activeTaskId ? { taskId: activeTaskId } : {}),
      summary: payload.compact_summary ?? 'Compact summary unavailable',
    });

    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostCompact',
        message: `Checkpoint recorded: ${checkpoint.id}`,
      },
    });
  }

  if (params.eventName === 'Stop') {
    const payload = JSON.parse(params.stdinPayload ?? '{}') as {
      last_assistant_message?: string;
      session_id?: string;
    };
    const activeTaskId = await resolveActiveTaskId(projectId);
    const sessionId =
      payload.session_id ?? (await getCurrentSessionId(params.cwd));
    const handoff = await createHandoff({
      projectId,
      taskId: activeTaskId ?? sessionId,
      fromActor: 'claude',
      toActor: 'next-agent',
      summary:
        payload.last_assistant_message ?? 'No assistant message captured',
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
