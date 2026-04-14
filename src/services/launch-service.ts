import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { adapterRegistry } from '../adapters/index.js';
import {
  buildLaunchArgs,
  codexLastMessagePath,
  resolveLaunchCommand,
} from '../adapters/launch.js';
import { loadStartContext } from './context-service.js';
import { getBoundProjectId, readProject } from './project-service.js';
import {
  SESSION_ENV_VAR,
  getCurrentSessionId,
  startSession,
} from './session-service.js';
import { setupProject } from './setup-service.js';
import { createCheckpoint } from './task-service.js';

export interface PreparedLaunch {
  command: string;
  args: string[];
  startupContext: string;
  projectId: string;
  bootstrapFilePath: string;
}

export interface LaunchResult extends PreparedLaunch {
  exitCode: number;
}

async function ensureProjectReady(cwd: string): Promise<string> {
  const existingProjectId = await getBoundProjectId(cwd);
  if (existingProjectId) {
    return existingProjectId;
  }

  const setup = await setupProject(cwd);
  return setup.project.id;
}

async function writeBootstrapFile(params: {
  cwd: string;
  agent: 'claude' | 'codex';
  startupContext: string;
}): Promise<string> {
  const bootstrapDir = path.join(params.cwd, '.memorize', 'bootstrap');
  await fs.mkdir(bootstrapDir, { recursive: true });
  const filePath = path.join(bootstrapDir, `${params.agent}-startup.md`);
  await fs.writeFile(filePath, `${params.startupContext}\n`, 'utf8');
  return filePath;
}

async function captureCodexLastMessage(params: {
  cwd: string;
  projectId: string;
  preparedArgs: string[];
}): Promise<void> {
  const outputFlagIndex = params.preparedArgs.indexOf('--output-last-message');
  const outputFile =
    outputFlagIndex !== -1
      ? params.preparedArgs[outputFlagIndex + 1]
      : codexLastMessagePath(params.cwd);
  if (!outputFile) return;

  try {
    const lastMessage = await fs.readFile(outputFile, 'utf8');
    const project = await readProject(params.projectId);
    const activeTaskId = project?.activeTaskIds[0];
    const sessionId = await getCurrentSessionId(params.cwd);
    await createCheckpoint({
      projectId: params.projectId,
      ...(activeTaskId ? { taskId: activeTaskId } : {}),
      sessionId,
      summary: lastMessage.trim() || 'Codex last message unavailable',
    });
  } catch {
    // best-effort lifecycle capture
  }
}

export async function prepareLaunch(params: {
  agent: 'claude' | 'codex';
  cwd: string;
  passthroughArgs?: string[];
}): Promise<PreparedLaunch> {
  const projectId = await ensureProjectReady(params.cwd);
  const payload = await loadStartContext({ projectId });
  const adapter = adapterRegistry[params.agent];
  if (!adapter) {
    throw new Error(`Adapter ${params.agent} is not registered.`);
  }

  const startupContext = adapter.renderStartupContext(payload);
  const bootstrapFilePath = await writeBootstrapFile({
    cwd: params.cwd,
    agent: params.agent,
    startupContext,
  });
  const command = resolveLaunchCommand(params.agent);
  const args = buildLaunchArgs({
    agent: params.agent,
    startupContext,
    passthroughArgs: params.passthroughArgs ?? [],
    cwd: params.cwd,
  });

  return {
    command,
    args,
    startupContext,
    projectId,
    bootstrapFilePath,
  };
}

export async function launchAgent(params: {
  agent: 'claude' | 'codex';
  cwd: string;
  passthroughArgs?: string[];
}): Promise<LaunchResult> {
  const prepared = await prepareLaunch(params);
  const sessionId = await startSession(params.cwd, params.agent);

  process.stdout.write(`Launching ${params.agent} with Memorize bootstrap\n`);
  process.stdout.write(`Bootstrap file: ${prepared.bootstrapFilePath}\n`);
  process.stdout.write(`Session id: ${sessionId}\n`);

  const result = spawnSync(prepared.command, prepared.args, {
    cwd: params.cwd,
    env: {
      ...process.env,
      MEMORIZE_STARTUP_CONTEXT: prepared.startupContext,
      MEMORIZE_PROJECT_ID: prepared.projectId,
      MEMORIZE_BOOTSTRAP_FILE: prepared.bootstrapFilePath,
      [SESSION_ENV_VAR]: sessionId,
    },
    stdio: 'inherit',
  });

  if (params.agent === 'codex') {
    await captureCodexLastMessage({
      cwd: params.cwd,
      projectId: prepared.projectId,
      preparedArgs: prepared.args,
    });
  }

  return {
    ...prepared,
    exitCode: result.status ?? 1,
  };
}
