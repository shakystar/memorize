import path from 'node:path';

import { createFileSyncTransport } from '../../adapters/sync-transport-file.js';
import {
  createProject,
  getBoundProjectId,
  readProject,
  readSyncState,
} from '../../services/project-service.js';
import { inspectProject } from '../../services/repair-service.js';
import { setupProject } from '../../services/setup-service.js';
import {
  getQueueSnapshot,
  pullProject,
  pushProject,
  updateSyncState,
} from '../../services/sync-service.js';
import type { CliContext } from '../context.js';
import { parseFlags } from '../parse-flags.js';
import { renderScaffoldUsage } from '../usage.js';

export async function runProjectCommand(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  const subcommand = args[0];
  const { cwd } = ctx;

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

  console.log(renderScaffoldUsage());
}
