import {
  ACTOR_SYSTEM,
  CURRENT_SCHEMA_VERSION,
  assertValidId,
  nowIso,
} from '../domain/common.js';
import { isPersonalStoreId } from '../domain/identity/personal-store.js';
import type { ProjectSyncState, SyncTransportConfig } from '../domain/entities.js';
import type {
  SyncPullResponse,
  SyncPullResult,
  SyncPushRequest,
  SyncPushResponse,
  SyncQueueSnapshot,
} from '../domain/sync-protocol.js';
import type { SyncTransport } from '../domain/sync-transport.js';
import { bindProject, resolveProjectIdForPath } from '../storage/bindings-store.js';
import {
  appendEvent,
  ensureProjectDirectories,
  insertExternalEvents,
  readEventsSince,
} from '../storage/event-store.js';
import { readJson, writeJson } from '../storage/fs-utils.js';
import { getSyncFile } from '../storage/path-resolver.js';
import {
  decryptEventPayload,
  encryptEventPayload,
  isEncryptedEnvelope,
} from './encryption-service.js';
import { rebuildProjectProjection } from './projection-store.js';
import { createProject } from './project-service.js';

const WORKSPACE_REMOTE_ID_PATTERN = /^wsp_[A-Za-z0-9_-]+$/;

function isWorkspaceRemoteId(id: string): boolean {
  return id.startsWith('wsp_');
}

function assertValidWorkspaceRemoteId(id: string): void {
  if (!WORKSPACE_REMOTE_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid remoteProjectId: ${JSON.stringify(id)} (must be a wsp_ remote store id)`,
    );
  }
}

function titleFromClonePath(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, '');
  const last = normalized.split(/[\\/]/).filter(Boolean).at(-1);
  return last || 'workspace clone';
}

/**
 * Hard privacy boundary (Path A, decision §4-#4): the global/personal store
 * NEVER leaves the host. It has no sync state, so the normal path already fails,
 * but every sync entry point asserts this explicitly so a future caller cannot
 * accidentally push, pull, clone, or even build a push payload for personal
 * memory. This is the structural fix for the #181-class personal-preference
 * leak — enforced in code, not by convention.
 */
function assertNotPersonalStore(projectId: string): void {
  if (isPersonalStoreId(projectId)) {
    throw new Error(
      `Refusing to sync the personal store (${projectId}): global personal ` +
        `memory is private and never leaves this host.`,
    );
  }
}

async function readStateOrThrow(projectId: string): Promise<ProjectSyncState> {
  const state = await readJson<ProjectSyncState>(getSyncFile(projectId));
  if (!state) {
    throw new Error(`Sync state is missing for project ${projectId}.`);
  }
  return state;
}

async function writeState(state: ProjectSyncState): Promise<void> {
  await writeJson(getSyncFile(state.projectId), state);
  await appendEvent({
    type: 'sync.state.updated',
    projectId: state.projectId,
    scopeType: 'project',
    scopeId: state.projectId,
    actor: ACTOR_SYSTEM,
    payload: state,
  });
}

export async function updateSyncState(
  projectId: string,
  patch: Partial<
    Omit<
      ProjectSyncState,
      'id' | 'projectId' | 'createdAt' | 'schemaVersion' | 'encryptionKey'
    >
  > & {
    // Permit explicitly clearing the E2E key (`encryption disable`). Under
    // exactOptionalPropertyTypes, `encryptionKey: undefined` is distinct from
    // "absent" and must be allowed here; the merge below sets it to undefined
    // and writeJson drops it from the persisted state, removing the key.
    encryptionKey?: string | undefined;
  },
): Promise<ProjectSyncState> {
  const current = await readStateOrThrow(projectId);
  // Pull encryptionKey out of the spread: it is the one field that may be
  // explicitly undefined (to clear it), which the typed literal can't hold.
  const { encryptionKey, ...rest } = patch;
  const next: ProjectSyncState = {
    ...current,
    ...rest,
    updatedAt: nowIso(),
  };
  if ('encryptionKey' in patch) {
    if (encryptionKey === undefined) {
      delete next.encryptionKey;
    } else {
      next.encryptionKey = encryptionKey;
    }
  }
  await writeState(next);
  return next;
}

export async function buildPushPayload(
  projectId: string,
  opts: { allowPersonal?: boolean } = {},
): Promise<SyncPushRequest> {
  if (!opts.allowPersonal) assertNotPersonalStore(projectId);
  const state = await readStateOrThrow(projectId);
  // Seq-watermark slice: events with seq greater than the lastPushed row,
  // in seq order. Still excludes local sync bookkeeping events.
  const pending = (
    await readEventsSince(projectId, state.lastPushedEventId)
  ).filter((event) => event.type !== 'sync.state.updated');
  return {
    projectId,
    ...(state.remoteProjectId ? { remoteProjectId: state.remoteProjectId } : {}),
    ...(state.lastPushedEventId
      ? { sincePushedEventId: state.lastPushedEventId }
      : {}),
    events: pending,
  };
}

export async function markPushed(
  projectId: string,
  lastAcceptedEventId: string,
): Promise<ProjectSyncState> {
  return updateSyncState(projectId, {
    lastPushedEventId: lastAcceptedEventId,
    lastSyncAt: nowIso(),
  });
}

/**
 * Apply-on-pull. Insert pulled events into the SQLite log (INSERT OR IGNORE,
 * idempotent), rebuild the projection, THEN advance the watermark last. A crash
 * before the watermark advances leaves it stale, so the next pull re-requests
 * the same range and converges (dupes ignored + idempotent rebuild). Returns
 * the number of newly inserted events.
 */
export async function applyPullResponse(
  projectId: string,
  response: SyncPullResponse,
): Promise<number> {
  const inserted = await insertExternalEvents(projectId, response.events);
  await rebuildProjectProjection(projectId);
  if (response.lastRemoteEventId) {
    await updateSyncState(projectId, {
      lastPulledEventId: response.lastRemoteEventId,
      lastSyncAt: nowIso(),
    });
  }
  return inserted;
}

export async function pushProject(
  projectId: string,
  transport: SyncTransport,
  opts: { allowPersonal?: boolean } = {},
): Promise<SyncPushResponse> {
  if (!opts.allowPersonal) assertNotPersonalStore(projectId);
  let state = await readStateOrThrow(projectId);
  // First push self-binds the remote (true-replica origin). One-time write.
  // A personal store never self-binds to its local id — its remote is a
  // server-minted psm_ that must be resolved and bound BEFORE this call.
  if (!state.remoteProjectId) {
    if (opts.allowPersonal) {
      throw new Error(
        `Personal store ${projectId} has no bound remote store id; resolve its ` +
          `psm_ (GET /v1/account/personal-store) and bind it before pushing.`,
      );
    }
    state = await updateSyncState(projectId, {
      remoteProjectId: projectId,
      syncEnabled: true,
    });
  }

  // Build the slice BEFORE flipping status, so a no-op push (the common case
  // at an auto-sync boundary with nothing new) writes ZERO sync.state.updated
  // events when already idle — avoids per-boundary log churn now that this
  // runs automatically.
  const payload = await buildPushPayload(projectId, opts);
  if (payload.events.length === 0) {
    if (state.syncStatus !== 'idle') {
      await updateSyncState(projectId, { syncStatus: 'idle' });
    }
    return { accepted: [], rejected: [] };
  }

  if (state.syncStatus !== 'syncing') {
    await updateSyncState(projectId, { syncStatus: 'syncing' });
  }

  // E2E encryption (#182): when a project key is set, encrypt each event's
  // payload just before it leaves the machine. buildPushPayload stays plaintext
  // (it also feeds getQueueSnapshot's counting), so this is the single push-side
  // encryption point. Event ids are unchanged, so the watermark below still works.
  const wirePayload = state.encryptionKey
    ? {
        ...payload,
        events: payload.events.map((event) =>
          encryptEventPayload(event, state.encryptionKey as string),
        ),
      }
    : payload;

  const response = await transport.push(wirePayload);
  if (response.lastAcceptedEventId) {
    await markPushed(projectId, response.lastAcceptedEventId);
  }
  await updateSyncState(projectId, { syncStatus: 'idle' });
  return response;
}

export async function pullProject(
  projectId: string,
  transport: SyncTransport,
  opts: { allowPersonal?: boolean } = {},
): Promise<SyncPullResult> {
  if (!opts.allowPersonal) assertNotPersonalStore(projectId);
  const state = await readStateOrThrow(projectId);
  if (!state.remoteProjectId) {
    throw new Error(
      `Cannot pull: project ${projectId} has no remoteProjectId. Push first to bind the remote.`,
    );
  }
  await updateSyncState(projectId, { syncStatus: 'syncing' });

  const response = await transport.pull({
    projectId,
    remoteProjectId: state.remoteProjectId,
    ...(state.lastPulledEventId
      ? { sincePulledEventId: state.lastPulledEventId }
      : {}),
  });

  let inserted = 0;
  if (response.events.length > 0) {
    // Fail closed (#195/#198): with no key configured but encrypted envelopes on
    // the wire (e.g. cloning a keyed project without --encryption-key), refuse
    // BEFORE any write. Inserting ciphertext would bind the replica to an
    // unusable projection AND burn the event ids, so a later keyed pull is then
    // dropped as a duplicate and the clone cannot self-repair.
    if (!state.encryptionKey && response.events.some((e) => isEncryptedEnvelope(e.payload))) {
      // Leave syncStatus as-is (mirrors a transport.pull() failure above): the
      // retry with the key sets it back to idle. Touching it here would append a
      // sync.state.updated to a fresh clone's store before its project.created.
      throw new Error(
        `Cannot pull project ${projectId}: the remote sent encrypted payloads ` +
          `but no encryption key is configured. Provision the key first — clone ` +
          `with \`memorize project clone ${state.remoteProjectId} --remote-url ` +
          `<url> --encryption-key <key>\`, or set it on this project with ` +
          `\`memorize project encryption enable --key <key>\` — then pull again.`,
      );
    }
    // Decrypt payloads back to plaintext before they hit the local store, so the
    // SQLite log and projection only ever see cleartext (#182). Plaintext
    // payloads (un-keyed peers, legacy events) pass through untouched.
    const decrypted = state.encryptionKey
      ? {
          ...response,
          events: response.events.map((event) =>
            decryptEventPayload(event, state.encryptionKey as string),
          ),
        }
      : response;
    inserted = await applyPullResponse(projectId, decrypted);
  }
  await updateSyncState(projectId, { syncStatus: 'idle' });

  return {
    total: response.events.length,
    inserted,
    ...(response.lastRemoteEventId
      ? { lastRemoteEventId: response.lastRemoteEventId }
      : {}),
  };
}

export interface CloneResult {
  /** The local projectId bound to the cwd. Legacy proj_ clones adopt the remote id. */
  projectId: string;
  /** Events pulled from the remote during the clone. */
  pulled: number;
}

/**
 * Clone-on-bind has two eras:
 *
 * - Legacy `proj_` remotes keep the #30 true-replica behavior: a fresh cwd
 *   adopts the remote projectId so both machines share one local identity.
 * - Hub workspace `wsp_` remotes follow SoT-021/022: the server-minted id is the
 *   remote routing key layered over a local `proj_`, never a replacement for it.
 *   A fresh cwd therefore mints a local project and binds its sync state to the
 *   opaque `wsp_` before the initial pull.
 */
export async function cloneProject(
  cwd: string,
  remoteProjectId: string,
  transport: SyncTransport,
  transportConfig?: SyncTransportConfig,
  // E2E key (#182), provisioned out-of-band at clone time. Must be seeded into
  // the sync state BEFORE the clone-time pull below, or that pull cannot decrypt
  // the remote's encrypted payloads. CLI plumbing (`--encryption-key`) is a
  // follow-up; this seam lets the function clone an encrypted project today.
  encryptionKey?: string,
): Promise<CloneResult> {
  // Fresh-cwd guard. Bound to the SAME id → idempotent re-pull below. Bound to
  // a DIFFERENT id → refuse: that is a diverged-history merge (#30 follow-up),
  // not a clone. Converting today's SILENT clobber into a loud failure.
  const existing = await resolveProjectIdForPath(cwd);

  if (isWorkspaceRemoteId(remoteProjectId)) {
    assertValidWorkspaceRemoteId(remoteProjectId);

    let localProjectId = existing;
    if (localProjectId) {
      const current = await readJson<ProjectSyncState>(getSyncFile(localProjectId));
      if (current?.remoteProjectId !== remoteProjectId) {
        throw new Error(
          `Directory is already bound to project ${localProjectId}. Clone requires a ` +
            `fresh directory; re-binding existing local history to a remote ` +
            `(diverged-history merge) is not yet supported (#30 follow-up).`,
        );
      }
      if (transportConfig || encryptionKey) {
        await updateSyncState(localProjectId, {
          ...(transportConfig ? { syncTransport: transportConfig } : {}),
          ...(encryptionKey ? { encryptionKey } : {}),
          syncEnabled: true,
        });
      }
    } else {
      const project = await createProject({
        title: titleFromClonePath(cwd),
        rootPath: cwd,
      });
      localProjectId = project.id;
      await updateSyncState(localProjectId, {
        remoteProjectId,
        syncEnabled: true,
        ...(transportConfig ? { syncTransport: transportConfig } : {}),
        ...(encryptionKey ? { encryptionKey } : {}),
      });
    }

    const result = await pullProject(localProjectId, transport);
    return { projectId: localProjectId, pulled: result.inserted };
  }

  assertValidId(remoteProjectId, 'remoteProjectId');
  assertNotPersonalStore(remoteProjectId);

  if (existing && existing !== remoteProjectId) {
    throw new Error(
      `Directory is already bound to project ${existing}. Clone requires a ` +
        `fresh directory; re-binding existing local history to a remote ` +
        `(diverged-history merge) is not yet supported (#30 follow-up).`,
    );
  }

  if (!existing) {
    // Adopt the remote identity WITHOUT minting a new project. Write the sync
    // state with writeJson — NOT writeState/updateSyncState, which append a
    // `sync.state.updated` event that would become seq 1 and make the first
    // rebuild throw "no project.created". The pull below brings the remote's
    // `project.created` as the first event instead. The pre-seeded
    // remoteProjectId is what lets pullProject pass its own guard.
    await ensureProjectDirectories(remoteProjectId);
    const now = nowIso();
    const initial: ProjectSyncState = {
      id: `sync_${remoteProjectId}`,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
      projectId: remoteProjectId,
      remoteProjectId,
      syncEnabled: true,
      // Persist WHERE to sync so later boundaries auto-push/pull with no flag.
      ...(transportConfig ? { syncTransport: transportConfig } : {}),
      // Seed the E2E key so the clone-time pull (below) can decrypt payloads.
      ...(encryptionKey ? { encryptionKey } : {}),
      syncStatus: 'idle',
    };
    await writeJson(getSyncFile(remoteProjectId), initial);
    await bindProject(cwd, remoteProjectId);
  } else if (encryptionKey) {
    // Re-clone recovery: a prior keyless clone of an encrypted remote seeded the
    // sync state WITHOUT a key and then failed closed in the pull below (no events
    // landed). Retrying with the key must adopt it, but updateSyncState would
    // append a `sync.state.updated` as the store's first event and make rebuild
    // throw "no project.created" — so patch the sync file directly, mirroring the
    // seed path above.
    const syncFile = getSyncFile(remoteProjectId);
    const current = await readJson<ProjectSyncState>(syncFile);
    if (current && current.encryptionKey !== encryptionKey) {
      await writeJson(syncFile, {
        ...current,
        encryptionKey,
        updatedAt: nowIso(),
      });
    }
  }

  const result = await pullProject(remoteProjectId, transport);
  return { projectId: remoteProjectId, pulled: result.inserted };
}

export async function getQueueSnapshot(
  projectId: string,
): Promise<SyncQueueSnapshot> {
  const [state, push] = await Promise.all([
    readStateOrThrow(projectId),
    buildPushPayload(projectId),
  ]);
  return {
    outboundPendingCount: push.events.length,
    ...(state.lastPushedEventId
      ? { lastPushedEventId: state.lastPushedEventId }
      : {}),
    ...(state.lastPulledEventId
      ? { lastPulledEventId: state.lastPulledEventId }
      : {}),
  };
}
