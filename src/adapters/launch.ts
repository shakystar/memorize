import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { adapterRegistry } from './index.js';
import { createCheckpoint } from '../services/task-service.js';
import { getBoundProjectId, readProject } from '../services/project-service.js';
import { setupProject } from '../services/setup-service.js';
import { loadStartContext } from '../services/context-service.js';

export interface LaunchResult {
  command: string;
  args: string[];
  startupContext: string;
  projectId: string;
  bootstrapFilePath: string;
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

function resolveLaunchCommand(agent: 'claude' | 'codex'): string {
  const envName = agent === 'claude' ? 'MEMORIZE_CLAUDE_BIN' : 'MEMORIZE_CODEX_BIN';
  return process.env[envName] || agent;
}

function buildLaunchArgs(params: {
  agent: 'claude' | 'codex';
  startupContext: string;
  passthroughArgs: string[];
  cwd: string;
}): string[] {
  if (params.agent === 'claude') {
    return [
      '--append-system-prompt',
      params.startupContext,
      ...params.passthroughArgs,
    ];
  }

  const passthrough = [...params.passthroughArgs];
  if (
    passthrough[0] === 'exec' &&
    !passthrough.includes('--output-last-message')
  ) {
    passthrough.push(
      '--output-last-message',
      path.join(params.cwd, '.memorize', 'bootstrap', 'codex-last-message.txt'),
    );
  }

  return [params.startupContext, ...passthrough];
}

export interface PreparedLaunch {
  command: string;
  args: string[];
  startupContext: string;
  projectId: string;
  bootstrapFilePath: string;
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

  process.stdout.write(`Launching ${params.agent} with Memorize bootstrap\n`);
  process.stdout.write(`Bootstrap file: ${prepared.bootstrapFilePath}\n`);

  const result = spawnSync(prepared.command, prepared.args, {
    cwd: params.cwd,
    env: {
      ...process.env,
      MEMORIZE_STARTUP_CONTEXT: prepared.startupContext,
      MEMORIZE_PROJECT_ID: prepared.projectId,
      MEMORIZE_BOOTSTRAP_FILE: prepared.bootstrapFilePath,
    },
    stdio: 'inherit',
  });

  if (params.agent === 'codex') {
    const outputFlagIndex = prepared.args.indexOf('--output-last-message');
    if (outputFlagIndex !== -1) {
      const outputFile = prepared.args[outputFlagIndex + 1];
      if (outputFile) {
        try {
          const lastMessage = await fs.readFile(outputFile, 'utf8');
          const project = await readProject(prepared.projectId);
          const activeTaskId = project?.activeTaskIds[0];
          await createCheckpoint({
            projectId: prepared.projectId,
            ...(activeTaskId ? { taskId: activeTaskId } : {}),
            sessionId: `codex_${Date.now()}`,
            summary: lastMessage.trim() || 'Codex last message unavailable',
          });
        } catch {
          // best-effort lifecycle capture
        }
      }
    }
  }

  return {
    command: prepared.command,
    args: prepared.args,
    startupContext: prepared.startupContext,
    projectId: prepared.projectId,
    bootstrapFilePath: prepared.bootstrapFilePath,
    exitCode: result.status ?? 1,
  };
}
