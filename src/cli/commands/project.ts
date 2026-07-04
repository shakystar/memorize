import path from 'node:path';

import { createFileSyncTransport } from '../../adapters/sync-transport-file.js';
import { createHttpSyncTransport } from '../../adapters/sync-transport-http.js';
import type { ProjectSyncState, SyncTransportConfig } from '../../domain/entities.js';
import type { SyncTransport } from '../../domain/sync-transport.js';
import { ACTOR_USER } from '../../domain/common.js';
import { resolveSyncToken, setToken } from '../../storage/credentials-store.js';
import { generateProjectKey, keyId } from '../../services/encryption-service.js';
import {
  createProject,
  getBindingForPath,
  readDecision,
  readDecisions,
  readProject,
  readSyncState,
  recordDecision,
  relocateProject,
  requireBoundProjectId,
  supersedeDecision,
} from '../../services/project-service.js';
import { resolveTransport } from '../../services/auto-sync-service.js';
import { inspectProject } from '../../services/repair-service.js';
import { computeRepoIdentity } from '../../services/repo-identity.js';
import { setupProject } from '../../services/setup-service.js';
import {
  tryEnsureSourceStoreRegistration,
  tryReconcileWorkspaceBinding,
  tryRefreshWorkspaceBinding,
} from '../../services/workspace-service.js';
import {
  cloneProject,
  getQueueSnapshot,
  pullProject,
  pushProject,
  updateSyncState,
} from '../../services/sync-service.js';
import type { CliContext } from '../context.js';
import { isHttpUrl, parseHubUrl } from '../hub-url.js';
import { parseFlags } from '../parse-flags.js';
import { renderPushResult } from '../sync-messages.js';
import { renderScaffoldUsage } from '../usage.js';

/**
 * Resolve a sync transport + the config to persist from CLI flags. Exactly one
 * of `--remote-path` (file) or `--remote-url` (http relay, P3-b-2) is required;
 * `--token` is only meaningful with `--remote-url`. The returned config is
 * written to ProjectSyncState so later boundaries auto-sync with no flag.
 *
 * For `--remote-url`, the bearer token follows the #192 ladder (explicit
 * `--token` → host credential store → env). Anti-sprawl (#192): an explicit
 * `--token` is written THROUGH to the host credential store (the git-credential
 * model — authenticate once per host) and is NEVER persisted into the per-project
 * config, which carries only `{ type, url }`. Auto-sync then re-resolves the
 * token host-side at runtime, so the secret lives in exactly one place.
 */
async function resolveTransportFlags(flags: {
  'remote-path'?: string;
  'remote-url'?: string;
  token?: string;
}): Promise<{ transport: SyncTransport; config: SyncTransportConfig }> {
  const remotePath = flags['remote-path'];
  const remoteUrl = flags['remote-url'];
  if (remotePath && remoteUrl) {
    throw new Error('Pass only one of --remote-path or --remote-url, not both.');
  }
  if (remoteUrl) {
    const explicit = flags.token;
    // Write an explicit --token through to the host store so future syncs of any
    // project on this host resolve it without re-passing the flag, and so it is
    // not duplicated into every project's sync state (anti-sprawl).
    if (explicit) {
      await setToken(remoteUrl, explicit);
    }
    const token = await resolveSyncToken(remoteUrl, explicit);
    return {
      transport: createHttpSyncTransport(remoteUrl, token ? { token } : {}),
      config: { type: 'http', url: remoteUrl },
    };
  }
  if (remotePath) {
    if (flags.token) {
      throw new Error('--token is only valid with --remote-url.');
    }
    // SoT-031: the file transport is frozen legacy — it keeps working (no
    // server exists to mint store ids for a shared folder), but the canonical
    // remote sync path is the Hub.
    process.stderr.write(
      'WARN: --remote-path (file transport) is deprecated (SoT-031). It keeps ' +
        'working but is frozen and will be removed in a later release; use Hub ' +
        'sync instead (`memorize auth login --remote-url <hub>`, then ' +
        '`memorize workspace create`).\n',
    );
    return {
      transport: createFileSyncTransport(remotePath),
      config: { type: 'file', location: remotePath },
    };
  }
  throw new Error('--remote-path or --remote-url is required.');
}

function redactSyncStateForDisplay(state: ProjectSyncState): Record<string, unknown> {
  const { encryptionKey, syncTransport, ...display } = state;
  const out: Record<string, unknown> = { ...display };
  if (syncTransport) {
    out.syncTransport =
      syncTransport.type === 'http' && syncTransport.token
        ? { ...syncTransport, token: '[redacted]' }
        : syncTransport;
  }
  if (encryptionKey) {
    out.encryptionKey = '[redacted]';
    try {
      out.encryptionKeyId = keyId(encryptionKey);
    } catch {
      out.encryptionKeyId = 'unavailable';
    }
  }
  return out;
}

/**
 * Adopt a remote project into a FRESH dir (true-replica clone, #30). Caller has
 * already resolved the remote id + put `--remote-url` (etc.) into `flagArgs`.
 */
async function doClone(
  cwd: string,
  remoteProjectId: string,
  flagArgs: string[],
): Promise<void> {
  const flags = parseFlags(flagArgs, {
    single: ['remote-path', 'remote-url', 'token', 'encryption-key'],
  });
  const { transport, config } = await resolveTransportFlags(flags.single);
  const encryptionKey = flags.single['encryption-key'];
  if (encryptionKey) {
    keyId(encryptionKey);
  }
  const result = await cloneProject(
    cwd,
    remoteProjectId,
    transport,
    config,
    encryptionKey,
  );
  const encNote = encryptionKey
    ? ` E2E encryption is on (kid ${keyId(encryptionKey)}).`
    : '';
  console.log(
    result.pulled > 0
      ? `Cloned project ${result.projectId} (${result.pulled} events pulled).${encNote}`
      : `Bound to remote project ${result.projectId}; no events yet. ` +
          'Run `memorize project sync --pull --remote-path <path>` after the source pushes.' +
          encNote,
  );
}

/**
 * Attach a Hub remote to the EXISTING bound project + run the first push/pull
 * (git-remote analog). Requires a bound project in `cwd`.
 */
async function doRemote(
  cwd: string,
  target: string,
  flagArgs: string[],
): Promise<void> {
  const projectId = await requireBoundProjectId(cwd);
  const flags = parseFlags(flagArgs, { single: ['token'] });
  const hub = parseHubUrl(target);
  const { transport, config } = await resolveTransportFlags({
    'remote-url': hub.remoteUrl,
    ...(flags.single.token ? { token: flags.single.token } : {}),
  });
  await updateSyncState(projectId, {
    remoteProjectId: hub.remoteProjectId,
    syncEnabled: true,
    syncTransport: config,
  });
  await tryReconcileWorkspaceBinding(projectId);
  await tryEnsureSourceStoreRegistration(projectId);
  const pushed = await pushProject(projectId, transport);
  const pulled = await pullProject(projectId, transport);
  await tryRefreshWorkspaceBinding(projectId);
  const dupes = pulled.total - pulled.inserted;
  console.log(
    `Attached remote ${hub.remoteProjectId} (${hub.remoteUrl}).\n` +
      `First sync: pushed ${pushed.accepted.length} events, pulled ` +
      `${pulled.total} (${pulled.inserted} new, ${dupes} duplicates ` +
      `skipped). Session boundaries auto-sync from here on.`,
  );
}

export async function runProjectCommand(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  const subcommand = args[0];
  const { cwd } = ctx;

  if (subcommand === 'init') {
    const flags = parseFlags(args.slice(1), { boolean: ['force'] });
    const binding = await getBindingForPath(cwd);
    // Only an EXACT binding (this dir IS a project root) is "already bound". An
    // ancestor-only binding is the legitimate "create a separate nested project
    // here" path and must NOT be blocked (#151).
    if (binding?.kind === 'exact' && !flags.boolean.force) {
      throw new Error(
        `Directory is already bound to project ${binding.projectId}. ` +
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
    if (binding?.kind === 'ancestor') {
      console.log(
        `Note: this project is nested inside project ${binding.projectId} ` +
          `(bound at ${binding.matchedPath}).`,
      );
    }
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
    // True-replica join (#30): adopt the remote projectId in a FRESH dir.
    let remoteProjectId = args[1];
    let flagArgs = args.slice(2);
    // Git-style positional: `memorize clone https://hub/<anything>/<id>` carries
    // the remote + id in one copy-pasteable arg — expand to `<id> --remote-url`.
    if (remoteProjectId && isHttpUrl(remoteProjectId)) {
      const hub = parseHubUrl(remoteProjectId);
      remoteProjectId = hub.remoteProjectId;
      flagArgs = ['--remote-url', hub.remoteUrl, ...flagArgs];
    }
    if (!remoteProjectId) {
      throw new Error(
        'Usage: memorize clone <hub-url-ending-in-id> | ' +
          'memorize project clone <remoteProjectId> ' +
          '(--remote-path <path> | --remote-url <url> [--token <t>]) ' +
          '[--encryption-key <b64>]',
      );
    }
    await doClone(cwd, remoteProjectId, flagArgs);
    return;
  }

  if (subcommand === 'remote') {
    const target = args[1];
    if (!target) {
      // `git remote -v` analog: no arg prints the attached remote, if any.
      const projectId = await requireBoundProjectId(cwd);
      const state = await readSyncState(projectId);
      if (state?.syncTransport?.type === 'http') {
        console.log(
          `${state.remoteProjectId ?? projectId}\t${state.syncTransport.url}`,
        );
        return;
      }
      throw new Error(
        'Usage: memorize remote <hub-url-ending-in-id> [--token <t>] ' +
          '(no remote is attached yet)',
      );
    }
    await doRemote(cwd, target, args.slice(2));
    return;
  }

  if (subcommand === 'encryption') {
    // #182 — provision the per-project E2E key on the ORIGIN machine. The key is
    // local-only (never synced: `buildPushPayload` drops `sync.state.updated`),
    // so distribution to replicas is out-of-band — `enable`/`show` print it for
    // exactly that. Confidentiality only; orthogonal to the Hub bearer PAT.
    const projectId = await requireBoundProjectId(cwd);
    const action = args[1];
    const state = await readSyncState(projectId);
    if (!state) {
      throw new Error(`Sync state is missing for project ${projectId}.`);
    }

    if (action === 'show') {
      if (!state.encryptionKey) {
        console.log(`Encryption is not enabled for project ${projectId}.`);
        return;
      }
      console.log(
        `Encryption is ENABLED for project ${projectId}.\n` +
          `  key (share out-of-band): ${state.encryptionKey}\n` +
          `  kid (fingerprint):       ${keyId(state.encryptionKey)}`,
      );
      return;
    }

    if (action === 'enable') {
      const flags = parseFlags(args.slice(2), {
        single: ['key'],
        boolean: ['force'],
      });
      // Rotating the key strands already-synced ciphertext (decrypt fails on a
      // kid mismatch), so refuse to clobber an existing key without --force.
      if (state.encryptionKey && !flags.boolean.force) {
        throw new Error(
          `Encryption is already enabled for project ${projectId}. Changing ` +
            `the key makes already-synced ciphertext undecryptable (kid ` +
            `mismatch). Run \`memorize project encryption show\` to view the ` +
            `current key, or pass --force to replace it.`,
        );
      }
      const key = flags.single.key ?? generateProjectKey();
      const kid = keyId(key); // validates the key length; clear error on a typo
      await updateSyncState(projectId, { encryptionKey: key });
      const remoteId = state.remoteProjectId ?? projectId;
      console.log(
        `Encryption enabled for project ${projectId}.\n` +
          `  key (share out-of-band): ${key}\n` +
          `  kid (fingerprint):       ${kid}\n\n` +
          `On another machine, clone the encrypted replica with:\n` +
          `  memorize project clone ${remoteId} --remote-url <url> ` +
          `--encryption-key ${key}`,
      );
      return;
    }

    if (action === 'disable') {
      if (!state.encryptionKey) {
        console.log(`Encryption is not enabled for project ${projectId}.`);
        return;
      }
      await updateSyncState(projectId, { encryptionKey: undefined });
      console.log(
        `Encryption disabled for project ${projectId}. Future pushes send ` +
          `plaintext payloads (already-synced ciphertext is unaffected).`,
      );
      return;
    }

    throw new Error(
      'Usage: memorize project encryption ' +
        '(enable [--key <b64>] [--force] | show | disable)',
    );
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

  if (subcommand === 'decision' && args[1] === 'list') {
    const projectId = await requireBoundProjectId(cwd);
    const flags = parseFlags(args.slice(2), { boolean: ['json', 'all'] });
    const decisions = readDecisions(projectId, {
      includeSuperseded: flags.boolean.all === true,
    });
    if (flags.boolean.json) {
      console.log(JSON.stringify(decisions, null, 2));
      return;
    }
    for (const decision of decisions) {
      console.log(`${decision.id}\t${decision.status}\t${decision.title}`);
    }
    return;
  }

  if (subcommand === 'decision' && args[1] === 'show') {
    const projectId = await requireBoundProjectId(cwd);
    const flags = parseFlags(args.slice(2), { boolean: ['json'] });
    const decisionId = flags.positional[0];
    if (!decisionId) {
      throw new Error('Usage: memorize project decision show <id> [--json]');
    }
    const decision = readDecision(projectId, decisionId);
    if (!decision) {
      throw new Error(
        `decision show: no decision found with id ${decisionId}.`,
      );
    }
    if (flags.boolean.json) {
      console.log(JSON.stringify(decision, null, 2));
      return;
    }
    const lines: string[] = [
      `id:        ${decision.id}`,
      `status:    ${decision.status}`,
      `title:     ${decision.title}`,
    ];
    if (decision.supersededBy) {
      lines.push(`superseded by: ${decision.supersededBy}`);
    }
    lines.push('', `decision:  ${decision.decision}`);
    if (decision.rationale) lines.push(`rationale: ${decision.rationale}`);
    console.log(lines.join('\n'));
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

  if (subcommand === 'decision' && args[1] === 'supersede') {
    const projectId = await requireBoundProjectId(cwd);
    const oldDecisionId = args[2];
    if (!oldDecisionId || oldDecisionId.startsWith('--')) {
      throw new Error(
        'Usage: memorize project decision supersede <oldDecisionId> ' +
          '--title <text> --decision <text> [--rationale <text>] [--reason <text>]',
      );
    }
    const flags = parseFlags(args.slice(3), {
      single: ['title', 'decision', 'rationale', 'reason'],
    });
    const title = flags.single.title?.trim();
    const decisionText = flags.single.decision?.trim();
    if (!title) throw new Error('--title is required.');
    if (!decisionText) throw new Error('--decision is required.');
    const { decision, supersededId } = await supersedeDecision({
      projectId,
      supersedesId: oldDecisionId,
      title,
      decision: decisionText,
      ...(flags.single.rationale ? { rationale: flags.single.rationale } : {}),
      ...(flags.single.reason ? { reason: flags.single.reason } : {}),
      actor: ACTOR_USER,
    });
    console.log(
      `Superseded decision ${supersededId} with ${decision.id} (${decision.title})`,
    );
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
      let transport: SyncTransport;
      if (flags.single['remote-path'] || flags.single['remote-url']) {
        const resolved = await resolveTransportFlags(flags.single);
        transport = resolved.transport;
        // Persist the transport location so background auto-sync (P3-b) can run
        // at boundaries without a flag — this manual push/pull is how the origin
        // machine opts in.
        await updateSyncState(projectId, { syncTransport: resolved.config });
      } else {
        // Flag-less manual sync (W-b): fall back to the persisted transport —
        // present after a prior flagged sync or a workspace bind (which stores
        // the Hub URL). Same resolver auto-sync uses, incl. the token ladder.
        const state = await readSyncState(projectId);
        const persisted = state ? await resolveTransport(state) : undefined;
        if (!persisted) {
          throw new Error(
            '--remote-path or --remote-url is required (no transport is ' +
              'persisted for this project yet).',
          );
        }
        transport = persisted;
      }
      // W-b full reconcile (SoT-031): converge a legacy Hub binding (proj_
      // self-bind, or wsp_ without its role cache) onto the canonical wsp_
      // BEFORE syncing. Best-effort; file transports are untouched.
      const preSyncState = await readSyncState(projectId);
      if (preSyncState?.syncTransport?.type === 'http') {
        await tryReconcileWorkspaceBinding(projectId);
        // Hub member attribution (best-effort, cached after once): declared
        // before the push so the Timeline can name this store's events.
        await tryEnsureSourceStoreRegistration(projectId);
      }
      if (flags.boolean.push) {
        const response = await pushProject(projectId, transport);
        // Post-push state: an empty push still reports the real watermark, so
        // the (common) nothing-pending case reads as healthy, not as `none`.
        const postPushState = await readSyncState(projectId);
        console.log(
          renderPushResult(response, postPushState?.lastPushedEventId),
        );
      }
      if (flags.boolean.pull) {
        const result = await pullProject(projectId, transport);
        const dupes = result.total - result.inserted;
        console.log(
          `Pulled ${result.total} events (${result.inserted} new, ${dupes} duplicates skipped). lastRemoteEventId=${result.lastRemoteEventId ?? 'none'}`,
        );
      }
      // W-c: a manual sync is a boundary too — re-read the workspace
      // role/reachability cache (best-effort; no-op unless workspace-bound).
      await tryRefreshWorkspaceBinding(projectId);
      return;
    }

    const syncState = await readSyncState(projectId);
    const queues = await getQueueSnapshot(projectId);
    console.log(
      `Project sync state: ${JSON.stringify(
        { state: syncState ? redactSyncStateForDisplay(syncState) : syncState, queues },
        null,
        2,
      )}`,
    );
    return;
  }

  console.log(renderScaffoldUsage());
}
