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
import { runClaudeHook } from '../services/hook-service.js';
import { setupProject } from '../services/setup-service.js';
import { createTask, readTask } from '../services/task-service.js';
import { runWorkflow } from '../workflows/macros/run.js';
import { parseIntent } from '../workflows/router.js';

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
        const syncState = await readSyncState(projectId);
        console.log(
          `Project sync state: ${JSON.stringify(syncState, null, 2)}`,
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
        console.log('Checkpoint workflow is not yet implemented.');
        return;
      }
      if (subcommand === 'handoff') {
        console.log('Handoff workflow is not yet implemented.');
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
