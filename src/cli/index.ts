import path from 'node:path';
import process from 'node:process';

import { launchAgent } from '../adapters/launch.js';
import { loadStartContext } from '../services/context-service.js';
import {
  installClaudeIntegration,
  installCodexIntegration,
} from '../services/install-service.js';
import {
  createProject,
  getBoundProjectId,
  readProject,
  readSyncState,
} from '../services/project-service.js';
import {
  doctor,
  inspectProject,
  rebuildMemoryIndex,
  rebuildProjection,
  validateEvents,
} from '../services/repair-service.js';
import { createFileSyncTransport } from '../adapters/sync-transport-file.js';
import { runClaudeHook } from '../services/hook-service.js';
import { setupProject } from '../services/setup-service.js';
import {
  getQueueSnapshot,
  pullProject,
  pushProject,
  updateSyncState,
} from '../services/sync-service.js';
import {
  createCheckpoint,
  createHandoff,
  createTask,
  readTask,
} from '../services/task-service.js';
import { runWorkflow } from '../workflows/macros/run.js';
import { parseIntent } from '../workflows/router.js';

interface ParsedFlags {
  positional: string[];
  single: Record<string, string>;
  multi: Record<string, string[]>;
  boolean: Record<string, boolean>;
}

function parseFlags(
  args: string[],
  options: { multi?: string[]; single?: string[]; boolean?: string[] } = {},
): ParsedFlags {
  const multiKeys = new Set(options.multi ?? []);
  const singleKeys = new Set(options.single ?? []);
  const booleanKeys = new Set(options.boolean ?? []);
  const positional: string[] = [];
  const single: Record<string, string> = {};
  const multi: Record<string, string[]> = {};
  const boolean: Record<string, boolean> = {};

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? '';
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    if (booleanKeys.has(key)) {
      boolean[key] = true;
      continue;
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Flag --${key} requires a value.`);
    }
    i += 1;
    if (multiKeys.has(key)) {
      (multi[key] ??= []).push(value);
    } else if (singleKeys.has(key)) {
      single[key] = value;
    } else {
      throw new Error(`Unknown flag --${key}.`);
    }
  }

  return { positional, single, multi, boolean };
}

async function resolveTaskId(
  projectId: string,
  explicit: string | undefined,
): Promise<string | undefined> {
  if (explicit) return explicit;
  const project = await readProject(projectId);
  return project?.activeTaskIds[0];
}

async function fsReadStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) {
    return undefined;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

export function renderScaffoldUsage(): string {
  return [
    'Memorize CLI scaffold',
    '',
    'Available baseline commands (planned):',
    '- project init',
    '- project setup',
    '- project show',
    '- project inspect',
    '- projection rebuild',
    '- memory-index rebuild',
    '- events validate',
    '- doctor',
    '- install claude',
    '- install codex',
    '- hook claude SessionStart',
    '- launch claude',
    '- launch codex',
    '- task create',
    '- task resume',
    '- task checkpoint',
    '- task handoff',
    '- conflict list',
    '- do "<sentence>"',
  ].join('\n');
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  const cwd = process.cwd();

  switch (command) {
    case 'project': {
      const subcommand = args[0];
      if (subcommand === 'init') {
        const project = await createProject({
          title: path.basename(cwd),
          rootPath: cwd,
        });
        console.log(`Initialized project ${project.title} (${project.id})`);
        return;
      }
      if (subcommand === 'setup') {
        const result = await setupProject(cwd);
        console.log(
          `Initialized project ${result.project.title} (${result.project.id})\nImported context files: ${result.importedContextCount}`,
        );
        return;
      }
      if (subcommand === 'show') {
        const projectId = await getBoundProjectId(cwd);
        if (!projectId) throw new Error('No project bound to current directory.');
        const project = await readProject(projectId);
        console.log(JSON.stringify(project, null, 2));
        return;
      }
      if (subcommand === 'inspect') {
        console.log(await inspectProject(cwd));
        return;
      }
      if (subcommand === 'sync') {
        const projectId = await getBoundProjectId(cwd);
        if (!projectId) throw new Error('No project bound to current directory.');
        const flags = parseFlags(args.slice(1), {
          single: ['remote-path', 'bind'],
          boolean: ['push', 'pull'],
        });

        if (flags.single.bind) {
          const next = await updateSyncState(projectId, {
            remoteProjectId: flags.single.bind,
            syncEnabled: true,
          });
          console.log(`Bound remote project ${next.remoteProjectId}`);
          return;
        }

        if (flags.boolean.push || flags.boolean.pull) {
          const remotePath = flags.single['remote-path'];
          if (!remotePath) {
            throw new Error(
              '--remote-path is required when using --push or --pull.',
            );
          }
          const transport = createFileSyncTransport(remotePath);
          if (flags.boolean.push) {
            const response = await pushProject(projectId, transport);
            console.log(
              `Pushed ${response.accepted.length} events. lastAcceptedEventId=${response.lastAcceptedEventId ?? 'none'}`,
            );
          }
          if (flags.boolean.pull) {
            const response = await pullProject(projectId, transport);
            console.log(
              `Pulled ${response.events.length} events. lastRemoteEventId=${response.lastRemoteEventId ?? 'none'}`,
            );
          }
          return;
        }

        const syncState = await readSyncState(projectId);
        const queues = await getQueueSnapshot(projectId);
        console.log(
          `Project sync state: ${JSON.stringify(
            { state: syncState, queues },
            null,
            2,
          )}`,
        );
        return;
      }
      break;
    }
    case 'projection': {
      if (args[0] === 'rebuild') {
        console.log(await rebuildProjection(cwd));
        return;
      }
      break;
    }
    case 'memory-index': {
      if (args[0] === 'rebuild') {
        console.log(await rebuildMemoryIndex(cwd));
        return;
      }
      break;
    }
    case 'events': {
      if (args[0] === 'validate') {
        console.log(await validateEvents(cwd));
        return;
      }
      break;
    }
    case 'doctor': {
      console.log(await doctor(cwd));
      return;
    }
    case 'install': {
      const target = args[0];
      if (target === 'claude') {
        await installClaudeIntegration(cwd);
        console.log('Installed Claude integration');
        return;
      }
      if (target === 'codex') {
        await installCodexIntegration(cwd);
        console.log('Installed Codex integration');
        return;
      }
      throw new Error('Install target must be `claude` or `codex`.');
    }
    case 'hook': {
      const target = args[0];
      const eventName = args[1];
      if (target === 'claude') {
        if (!eventName) {
          throw new Error('Hook event name is required for Claude hooks.');
        }
        const stdinPayload = await fsReadStdin();
        process.stdout.write(
          await runClaudeHook({
            eventName,
            cwd,
            ...(stdinPayload !== undefined ? { stdinPayload } : {}),
          }),
        );
        return;
      }
      throw new Error('Only `claude` hooks are implemented currently.');
    }
    case 'launch': {
      const agent = args[0];
      if (agent !== 'claude' && agent !== 'codex') {
        throw new Error('Launch target must be `claude` or `codex`.');
      }
      const passthroughIndex = args.indexOf('--');
      const passthroughArgs =
        passthroughIndex === -1 ? [] : args.slice(passthroughIndex + 1);
      await launchAgent({
        agent,
        cwd,
        passthroughArgs,
      });
      return;
    }
    case 'task': {
      const projectId = await getBoundProjectId(cwd);
      if (!projectId) throw new Error('No project bound to current directory.');
      const subcommand = args[0];

      if (subcommand === 'create') {
        const title = args.slice(1).join(' ').trim();
        if (!title) throw new Error('Task title is required.');
        const task = await createTask({
          projectId,
          title,
          description: title,
          actor: 'user',
        });
        console.log(`Created task ${task.id}`);
        return;
      }
      if (subcommand === 'show') {
        const taskId = args[1];
        if (!taskId) throw new Error('Task id is required.');
        const task = await readTask(projectId, taskId);
        console.log(JSON.stringify(task, null, 2));
        return;
      }
      if (subcommand === 'resume' || subcommand === 'start') {
        const payload = await loadStartContext({ projectId });
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      if (subcommand === 'checkpoint') {
        const flags = parseFlags(args.slice(1), {
          single: ['summary', 'session', 'task'],
          multi: ['task-update', 'project-update', 'deferred', 'discard'],
        });
        const taskId = flags.single.task ?? flags.positional[0];
        const resolvedTaskId = await resolveTaskId(projectId, taskId);
        const summary = flags.single.summary;
        if (!summary) throw new Error('--summary is required for task checkpoint.');
        const checkpoint = await createCheckpoint({
          projectId,
          sessionId: flags.single.session ?? `session_${Date.now()}`,
          ...(resolvedTaskId ? { taskId: resolvedTaskId } : {}),
          summary,
          ...(flags.multi['task-update'] ? { taskUpdates: flags.multi['task-update'] } : {}),
          ...(flags.multi['project-update']
            ? { projectUpdates: flags.multi['project-update'] }
            : {}),
          ...(flags.multi.deferred ? { deferredItems: flags.multi.deferred } : {}),
          ...(flags.multi.discard ? { discardableItems: flags.multi.discard } : {}),
        });
        console.log(`Created checkpoint ${checkpoint.id}`);
        return;
      }
      if (subcommand === 'handoff') {
        const flags = parseFlags(args.slice(1), {
          single: ['summary', 'next', 'from', 'to', 'task', 'confidence'],
          multi: ['done', 'remaining', 'warning', 'question'],
        });
        const taskId = flags.single.task ?? flags.positional[0];
        const resolvedTaskId = await resolveTaskId(projectId, taskId);
        if (!resolvedTaskId) {
          throw new Error(
            'Handoff requires a taskId (pass as positional, --task, or ensure an active task exists).',
          );
        }
        const summary = flags.single.summary;
        const nextAction = flags.single.next;
        if (!summary) throw new Error('--summary is required for task handoff.');
        if (!nextAction) throw new Error('--next is required for task handoff.');
        const confidence = flags.single.confidence as
          | 'low'
          | 'medium'
          | 'high'
          | undefined;
        if (confidence && !['low', 'medium', 'high'].includes(confidence)) {
          throw new Error('--confidence must be one of low|medium|high.');
        }
        const handoff = await createHandoff({
          projectId,
          taskId: resolvedTaskId,
          fromActor: flags.single.from ?? 'user',
          toActor: flags.single.to ?? 'next-agent',
          summary,
          nextAction,
          ...(flags.multi.done ? { doneItems: flags.multi.done } : {}),
          ...(flags.multi.remaining ? { remainingItems: flags.multi.remaining } : {}),
          ...(flags.multi.warning ? { warnings: flags.multi.warning } : {}),
          ...(flags.multi.question ? { unresolvedQuestions: flags.multi.question } : {}),
          ...(confidence ? { confidence } : {}),
        });
        console.log(`Created handoff ${handoff.id}`);
        return;
      }
      break;
    }
    case 'conflict': {
      const projectId = await getBoundProjectId(cwd);
      if (!projectId) throw new Error('No project bound to current directory.');
      const payload = await loadStartContext({ projectId });
      console.log(JSON.stringify(payload.openConflicts, null, 2));
      return;
    }
    case 'do': {
      const sentence = args.join(' ').trim();
      if (!sentence) throw new Error('A sentence command is required.');
      console.log(await runWorkflow(parseIntent(sentence), cwd));
      return;
    }
    default:
      console.log(renderScaffoldUsage());
      return;
  }

  console.log(renderScaffoldUsage());
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
