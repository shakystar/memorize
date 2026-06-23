import path from 'node:path';

import { createFileSyncTransport } from '../../adapters/sync-transport-file.js';
import { createHttpSyncTransport } from '../../adapters/sync-transport-http.js';
import type { SyncTransportConfig } from '../../domain/entities.js';
import type { SyncTransport } from '../../domain/sync-transport.js';
import { ACTOR_USER } from '../../domain/common.js';
import {
  createProject,
  getBoundProjectId,
  readProject,
  readSyncState,
  recordDecision,
  relocateProject,
  requireBoundProjectId,
} from '../../services/project-service.js';
import { inspectProject } from '../../services/repair-service.js';
import { computeRepoIdentity } from '../../services/repo-identity.js';
import { setupProject } from '../../services/setup-service.js';
import {
  cloneProject,
  getQueueSnapshot,
  pullProject,
  pushProject,
  updateSyncState,
} from '../../services/sync-service.js';
import type { CliContext } from '../context.js';
import { parseFlags } from '../parse-flags.js';
import { renderScaffoldUsage } from '../usage.js';

/**
 * Resolve a sync transport + the config to persist from CLI flags. Exactly one
 * of `--remote-path` (file) or `--remote-url` (http relay, P3-b-2) is required;
 * `--token` is only meaningful with `--remote-url`. The returned config is
 * written to ProjectSyncState so later boundaries auto-sync with no flag.
 */
function resolveTransportFlags(flags: {
  'remote-path'?: string;
  'remote-url'?: string;
  token?: string;
}): { transport: SyncTransport; config: SyncTransportConfig } {
  const remotePath = flags['remote-path'];
  const remoteUrl = flags['remote-url'];
  if (remotePath && remoteUrl) {
    throw new Error('Pass only one of --remote-path or --remote-url, not both.');
  }
  if (remoteUrl) {
    const token = flags.token;
    return {
      transport: createHttpSyncTransport(
        remoteUrl,
        token ? { token } : {},
      ),
      config: { type: 'http', url: remoteUrl, ...(token ? { token } : {}) },
    };
  }
  if (remotePath) {
    if (flags.token) {
      throw new Error('--token is only valid with --remote-url.');
    }
    return {
      transport: createFileSyncTransport(remotePath),
      config: { type: 'file', location: remotePath },
    };
  }
  throw new Error('--remote-path or --remote-url is required.');
}

export async function runProjectCommand(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  const subcommand = args[0];
  const { cwd } = ctx;

  if (subcommand === 'init') {
    const flags = parseFlags(args.slice(1), { boolean: ['force'] });
    const existingProjectId = await getBoundProjectId(cwd);
    if (existingProjectId && !flags.boolean.force) {
      throw new Error(
        `Directory is already bound to project ${existingProjectId}. ` +
          `Run \`memorize project setup\` to adopt the existing project, ` +
          `or pass --force to overwrite the binding with a new project.`,
      );
    }
    // Capture git identity here too (#145) so an init'd project is protected by
    // move detection just like a setup'd one — otherwise it is born "legacy".
    const identity = computeRepoIdentity(cwd);
    const project = await createProject({
      title: path.basename(cwd),
      rootPath: cwd,
      ...(identity.originUrl ? { originUrl: identity.originUrl } : {}),
      ...(identity.rootCommit ? { rootCommit: identity.rootCommit } : {}),
    });
    console.log(`Initialized project ${project.title} (${project.id})`);
    return;
  }

  if (subcommand === 'setup') {
    const result = await setupProject(cwd);
    const verb = result.relocated ? 'Relocated existing project' : 'Initialized project';
    console.log(
      `${verb} ${result.project.title} (${result.project.id})\nImported context files: ${result.importedContextCount}`,
    );
    for (const warning of result.warnings) {
      console.warn(`\n⚠️  ${warning}`);
    }
    return;
  }

  if (subcommand === 'clone') {
    // True-replica join (#30): adopt the remote projectId in a FRESH dir so the
    // same project has one identity on every machine (git-clone analog).
    const remoteProjectId = args[1];
    if (!remoteProjectId) {
      throw new Error(
        'Usage: memorize project clone <remoteProjectId> ' +
          '(--remote-path <path> | --remote-url <url> [--token <t>])',
      );
    }
    const flags = parseFlags(args.slice(2), {
      single: ['remote-path', 'remote-url', 'token'],
    });
    // Persist the location so later boundaries auto-sync with no flag (P3-b).
    const { transport, config } = resolveTransportFlags(flags.single);
    const result = await cloneProject(cwd, remoteProjectId, transport, config);
    console.log(
      result.pulled > 0
        ? `Cloned project ${result.projectId} (${result.pulled} events pulled).`
        : `Bound to remote project ${result.projectId}; no events yet. ` +
            'Run `memorize project sync --pull --remote-path <path>` after the source pushes.',
    );
    return;
  }

  if (subcommand === 'relocate') {
    // #124 — rebind an EXISTING project to a new absolute path (e.g. machine
    // migration) instead of letting `project setup` mint a new empty project
    // and orphan the original's memory. Identify the source by --project <id>
    // or --from <oldPath>; <newPath> defaults to cwd.
    const flags = parseFlags(args.slice(1), {
      single: ['project', 'from'],
    });
    const newPath = flags.positional[0] ?? cwd;
    if (!flags.single.project && !flags.single.from) {
      throw new Error(
        'Usage: memorize project relocate [<newPath>] ' +
          '(--project <id> | --from <oldPath>)',
      );
    }
    const { project, alreadyBound } = await relocateProject({
      newPath,
      ...(flags.single.project ? { projectId: flags.single.project } : {}),
      ...(flags.single.from ? { fromPath: flags.single.from } : {}),
    });
    console.log(
      alreadyBound
        ? `Project ${project.title} (${project.id}) already bound to ${project.rootPath}; nothing to do.`
        : `Relocated project ${project.title} (${project.id}) to ${project.rootPath}`,
    );
    return;
  }

  if (subcommand === 'show') {
    const projectId = await requireBoundProjectId(cwd);
    const project = await readProject(projectId);
    console.log(JSON.stringify(project, null, 2));
    return;
  }

  if (subcommand === 'decision' && args[1] === 'add') {
    const projectId = await requireBoundProjectId(cwd);
    const flags = parseFlags(args.slice(2), {
      single: ['title', 'decision', 'rationale'],
    });
    const title = flags.single.title?.trim();
    const decisionText = flags.single.decision?.trim();
    if (!title) throw new Error('--title is required.');
    if (!decisionText) throw new Error('--decision is required.');
    const recorded = await recordDecision({
      projectId,
      title,
      decision: decisionText,
      ...(flags.single.rationale ? { rationale: flags.single.rationale } : {}),
      actor: ACTOR_USER,
    });
    console.log(`Recorded decision ${recorded.id} (${recorded.title})`);
    return;
  }

  if (subcommand === 'inspect') {
    console.log(await inspectProject(cwd));
    return;
  }

  if (subcommand === 'sync') {
    const projectId = await requireBoundProjectId(cwd);
    const flags = parseFlags(args.slice(1), {
      single: ['remote-path', 'remote-url', 'token', 'bind'],
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
      const { transport, config } = resolveTransportFlags(flags.single);
      // Persist the transport location so background auto-sync (P3-b) can run
      // at boundaries without a flag — this manual push/pull is how the origin
      // machine opts in.
      await updateSyncState(projectId, { syncTransport: config });
      if (flags.boolean.push) {
        const response = await pushProject(projectId, transport);
        console.log(
          `Pushed ${response.accepted.length} events. lastAcceptedEventId=${response.lastAcceptedEventId ?? 'none'}`,
        );
      }
      if (flags.boolean.pull) {
        const result = await pullProject(projectId, transport);
        const dupes = result.total - result.inserted;
        console.log(
          `Pulled ${result.total} events (${result.inserted} new, ${dupes} duplicates skipped). lastRemoteEventId=${result.lastRemoteEventId ?? 'none'}`,
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
