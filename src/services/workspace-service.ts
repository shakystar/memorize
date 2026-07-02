import {
  createWorkspace,
  getWorkspaceRoster,
  joinWorkspaceRemote,
  listWorkspaces,
  mintWorkspaceInvite,
  removeWorkspaceMember,
  setWorkspaceMemberRole,
  type WorkspaceInvite,
  type WorkspaceRole,
  type WorkspaceRoster,
} from '../adapters/sync-transport-http.js';
import { CURRENT_SCHEMA_VERSION, nowIso } from '../domain/common.js';
import type { ProjectSyncState } from '../domain/entities.js';
import { readToken, resolveSyncToken } from '../storage/credentials-store.js';
import { readJson, writeJson } from '../storage/fs-utils.js';
import { getSyncFile } from '../storage/path-resolver.js';

/**
 * W-a — workspace identity binding (memorize SoT-021/022, Hub H010/H040). Binds a
 * local project (`proj_`) to a server-minted workspace store (`wsp_`) WITHOUT
 * touching its local identity (no rekey) and WITHOUT any domain event: the `wsp_`,
 * `role`, and reachability are control-plane facts fetched from the gateway and
 * cached in the project's sync state (the mirror of the W1 `psm_` bind). The
 * whole-DB union push/pull that actually shares memory is W-b; W-a stops at
 * establishing identity.
 */
export interface WorkspaceBinding {
  /** Server-minted opaque `wsp_…` (also the project's `remoteProjectId`). */
  workspaceId: string;
  role: WorkspaceRole;
  inviteReachable: boolean;
}

export interface BindWorkspaceResult extends WorkspaceBinding {
  /** true = a fresh `wsp_` was minted; false = the project was already bound. */
  created: boolean;
}

/**
 * Read a project's workspace binding from its sync state, or `undefined` when the
 * project is not workspace-bound (a plain `proj_` sync, or unsynced). A binding
 * requires BOTH a `remoteProjectId` and the control-plane `workspaceRole` cache —
 * the latter is what distinguishes a `wsp_` binding from a legacy `proj_` self-bind.
 */
export async function getWorkspaceBinding(
  projectId: string,
): Promise<WorkspaceBinding | undefined> {
  const state = await readJson<ProjectSyncState>(getSyncFile(projectId));
  if (!state?.remoteProjectId || !state.workspaceRole) return undefined;
  return {
    workspaceId: state.remoteProjectId,
    role: state.workspaceRole,
    inviteReachable: state.inviteReachable ?? false,
  };
}

/**
 * Create a workspace for `projectId` and bind it. Idempotent: if the project is
 * already workspace-bound, returns the existing binding instead of minting a
 * duplicate `wsp_` (which would orphan the first). The token stays only in the
 * host credential store (#192). Writes the sync file directly (mirrors
 * `bindPersonalRemote`) — no `sync.state.updated` churn.
 */
export async function bindWorkspace(
  projectId: string,
  params: { remoteUrl: string; name?: string; fetchImpl?: typeof fetch },
): Promise<BindWorkspaceResult> {
  const already = await getWorkspaceBinding(projectId);
  if (already) return { ...already, created: false };

  const token = await readToken(params.remoteUrl);
  if (!token) {
    throw new Error(
      `No stored credential for ${params.remoteUrl}. Run ` +
        `\`memorize auth login --remote-url ${params.remoteUrl}\` first.`,
    );
  }

  const workspace = await createWorkspace(params.remoteUrl, token, {
    ...(params.name ? { name: params.name } : {}),
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
  });
  await writeWorkspaceBinding(projectId, params.remoteUrl, workspace);
  return {
    workspaceId: workspace.workspaceId,
    role: workspace.role,
    inviteReachable: workspace.inviteReachable,
    created: true,
  };
}

/**
 * Owner mints an invite for the bound workspace (W-d). The Hub flips the store
 * to `inviteReachable:true` on the first successful mint (private project ->
 * shared workspace); the local control-plane cache is mirrored immediately so
 * `workspace status` reflects it without a round-trip. The invite `token` is
 * shown ONCE — the Hub never re-serves it.
 */
export async function inviteToWorkspace(
  projectId: string,
  params: {
    remoteUrl?: string;
    maxUses?: number;
    expiresAt?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<WorkspaceInvite> {
  const { state, syncFile, workspaceId, remoteUrl, token } =
    await requireWorkspaceContext(projectId, params.remoteUrl);
  const invite = await mintWorkspaceInvite(remoteUrl, token, workspaceId, {
    ...(params.maxUses !== undefined ? { maxUses: params.maxUses } : {}),
    ...(params.expiresAt ? { expiresAt: params.expiresAt } : {}),
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
  });
  if (!state.inviteReachable) {
    await writeJson(syncFile, {
      ...state,
      inviteReachable: true,
      updatedAt: nowIso(),
    });
  }
  return invite;
}

/**
 * Redeem an invite and bind THIS project to the joined workspace (W-d) — the
 * member-side counterpart of `bindWorkspace`. Refuses a project that is already
 * workspace-bound (re-pointing an existing binding at a different `wsp_` would
 * silently split its history; unbind is a deliberate separate act). The joined
 * store is `inviteReachable` by definition — an invite existed to join through.
 */
export async function joinAndBindWorkspace(
  projectId: string,
  params: { remoteUrl: string; inviteToken: string; fetchImpl?: typeof fetch },
): Promise<WorkspaceBinding> {
  const already = await getWorkspaceBinding(projectId);
  if (already) {
    throw new Error(
      `Project is already bound to workspace ${already.workspaceId}. ` +
        'Joining a different workspace from the same project is not supported.',
    );
  }
  const token = await readToken(params.remoteUrl);
  if (!token) {
    throw new Error(
      `No stored credential for ${params.remoteUrl}. Run ` +
        `\`memorize auth login --remote-url ${params.remoteUrl}\` first.`,
    );
  }
  const joined = await joinWorkspaceRemote(
    params.remoteUrl,
    token,
    params.inviteToken,
    params.fetchImpl ? { fetchImpl: params.fetchImpl } : {},
  );
  const binding = {
    workspaceId: joined.workspaceId,
    role: joined.role,
    inviteReachable: true,
  };
  await writeWorkspaceBinding(projectId, params.remoteUrl, binding);
  return binding;
}

/**
 * Resolve everything a control-plane call against the BOUND workspace needs:
 * the sync state, the `wsp_` id, the Hub URL (explicit param wins over the
 * bind-persisted http transport), and a bearer token via the #192 ladder
 * (per-project persisted token -> host credential store -> env). Throws with
 * the actionable next command when any piece is missing.
 */
async function requireWorkspaceContext(
  projectId: string,
  remoteUrlOverride?: string,
): Promise<{
  state: ProjectSyncState;
  syncFile: string;
  workspaceId: string;
  remoteUrl: string;
  token: string;
}> {
  const syncFile = getSyncFile(projectId);
  const state = await readJson<ProjectSyncState>(syncFile);
  if (!state?.remoteProjectId || !state.workspaceRole) {
    throw new Error(
      'Project is not workspace-bound. Run `memorize workspace create` first.',
    );
  }
  const remoteUrl =
    remoteUrlOverride ??
    (state.syncTransport?.type === 'http' ? state.syncTransport.url : undefined);
  if (!remoteUrl) {
    throw new Error('No Hub URL known for this workspace. Pass --remote-url.');
  }
  const token = await resolveSyncToken(
    remoteUrl,
    state.syncTransport?.type === 'http' ? state.syncTransport.token : undefined,
  );
  if (!token) {
    throw new Error(
      `No stored credential for ${remoteUrl}. Run ` +
        `\`memorize auth login --remote-url ${remoteUrl}\` first.`,
    );
  }
  return { state, syncFile, workspaceId: state.remoteProjectId, remoteUrl, token };
}

/**
 * Refresh the control-plane cache (`workspaceRole`, `inviteReachable`) from the
 * Hub (W-c). The cache is NOT authority (SoT-022) — this is the sync-boundary
 * re-read that keeps it honest after a promote/demote or an invite flip made
 * elsewhere. Reads `GET /v1/account/workspaces` because it returns the CALLING
 * account's role per workspace; the roster (`GET /v1/workspaces/:id`) is
 * accountId-keyed and the client does not know its own Hub accountId, so it
 * cannot pick "me" out of it. Returns the fresh binding, or `undefined` when
 * the project is not workspace-bound OR the workspace no longer lists this
 * account (membership revoked / workspace deleted) — the caller decides how
 * loud to be; the stale cache is left in place as audit of what was last known.
 */
export async function refreshWorkspaceBinding(
  projectId: string,
  params: { remoteUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<WorkspaceBinding | undefined> {
  const binding = await getWorkspaceBinding(projectId);
  if (!binding) return undefined;
  const { state, syncFile, workspaceId, remoteUrl, token } =
    await requireWorkspaceContext(projectId, params.remoteUrl);
  const workspaces = await listWorkspaces(
    remoteUrl,
    token,
    params.fetchImpl ? { fetchImpl: params.fetchImpl } : {},
  );
  const entry = workspaces.find((w) => w.workspaceId === workspaceId);
  if (!entry) return undefined;
  if (
    entry.role !== state.workspaceRole ||
    entry.inviteReachable !== (state.inviteReachable ?? false)
  ) {
    await writeJson(syncFile, {
      ...state,
      workspaceRole: entry.role,
      inviteReachable: entry.inviteReachable,
      updatedAt: nowIso(),
    });
  }
  return {
    workspaceId,
    role: entry.role,
    inviteReachable: entry.inviteReachable,
  };
}

/**
 * Best-effort wrapper for sync boundaries (autoPull / manual `project sync`):
 * a cache refresh must never break the sync that triggered it. Degrades to a
 * stderr warn, mirroring auto-sync's own failure mode.
 */
export async function tryRefreshWorkspaceBinding(
  projectId: string,
  params: { remoteUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<WorkspaceBinding | undefined> {
  try {
    const binding = await getWorkspaceBinding(projectId);
    if (!binding) return undefined;
    const refreshed = await refreshWorkspaceBinding(projectId, params);
    if (!refreshed) {
      process.stderr.write(
        `WARN: workspace ${binding.workspaceId} no longer lists this account ` +
          `(membership revoked or workspace deleted); keeping the cached ` +
          `binding for audit.\n`,
      );
    }
    return refreshed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`WARN: workspace role refresh skipped (${message})\n`);
    return undefined;
  }
}

/**
 * Membership roster of the bound workspace (W-c) — co-writers, their roles and
 * verified emails (the display handle for provenance). Any member may read it.
 */
export async function listWorkspaceMembers(
  projectId: string,
  params: { remoteUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<WorkspaceRoster> {
  const { workspaceId, remoteUrl, token } = await requireWorkspaceContext(
    projectId,
    params.remoteUrl,
  );
  return getWorkspaceRoster(
    remoteUrl,
    token,
    workspaceId,
    params.fetchImpl ? { fetchImpl: params.fetchImpl } : {},
  );
}

/**
 * Resolve a CLI member reference — an `acc_…` id or a verified email — against
 * the roster. Exact accountId match wins; otherwise a case-insensitive email
 * match. Fails loud on no match (never guess a mutation target).
 */
function resolveMemberAccountId(roster: WorkspaceRoster, ref: string): string {
  const byId = roster.members.find((m) => m.accountId === ref);
  if (byId) return byId.accountId;
  const needle = ref.toLowerCase();
  const byEmail = roster.members.filter((m) => m.email.toLowerCase() === needle);
  if (byEmail.length === 1) return byEmail[0]!.accountId;
  if (byEmail.length > 1) {
    throw new Error(
      `Member reference "${ref}" matches ${byEmail.length} accounts; use the accountId.`,
    );
  }
  throw new Error(
    `No workspace member matches "${ref}". Run \`memorize workspace members\` to list them.`,
  );
}

/**
 * Owner changes a member's role (W-c): promote to `owner` (also the ownership
 * transfer path) or demote to `member`. The Hub enforces owner-auth and the
 * last-owner invariant; role/`invite_reachable` stay control-plane facts —
 * NO domain event is written (SoT-022). If the change touches the calling
 * account itself the local cache is picked up on the next sync-boundary
 * refresh (the client cannot tell "me" apart in the roster, see
 * refreshWorkspaceBinding).
 */
export async function changeWorkspaceMemberRole(
  projectId: string,
  memberRef: string,
  role: WorkspaceRole,
  params: { remoteUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ accountId: string; role: WorkspaceRole }> {
  const { workspaceId, remoteUrl, token } = await requireWorkspaceContext(
    projectId,
    params.remoteUrl,
  );
  const fetchOpts = params.fetchImpl ? { fetchImpl: params.fetchImpl } : {};
  const roster = await getWorkspaceRoster(remoteUrl, token, workspaceId, fetchOpts);
  const accountId = resolveMemberAccountId(roster, memberRef);
  return setWorkspaceMemberRole(
    remoteUrl,
    token,
    workspaceId,
    accountId,
    role,
    fetchOpts,
  );
}

/**
 * Remove a member (owner removing anyone; self-removal is the Hub's self-leave
 * path). Revokes future access only — already-pulled bytes are not recallable
 * (SoT-040/050), and the member's past events remain in the shared log as
 * provenance-labelled history.
 */
export async function removeMemberFromWorkspace(
  projectId: string,
  memberRef: string,
  params: { remoteUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ accountId: string }> {
  const { workspaceId, remoteUrl, token } = await requireWorkspaceContext(
    projectId,
    params.remoteUrl,
  );
  const fetchOpts = params.fetchImpl ? { fetchImpl: params.fetchImpl } : {};
  const roster = await getWorkspaceRoster(remoteUrl, token, workspaceId, fetchOpts);
  const accountId = resolveMemberAccountId(roster, memberRef);
  await removeWorkspaceMember(remoteUrl, token, workspaceId, accountId, fetchOpts);
  return { accountId };
}

/**
 * The owner-only GLOBAL retract gate (W-c, SoT-050 boundary, Hub H030). Called
 * by `retractMemory` when the target is a foreign-lane (another writer's)
 * memory. Prefers a LIVE role check (control-plane refresh); when the Hub is
 * unreachable it falls back to the cached role with a warn — the cache came
 * from an authenticated call, and the stamp is a trusted-membership claim
 * either way (H030's accepted trade-off), so refusing offline would only hurt
 * the honest path. Throws unless this project is workspace-bound as `owner`.
 */
export async function requireOwnerForGlobalRetract(
  projectId: string,
  params: { fetchImpl?: typeof fetch } = {},
): Promise<'owner'> {
  const cached = await getWorkspaceBinding(projectId);
  if (!cached) {
    throw new Error(
      'Cannot retract another writer\'s memory: this project is not ' +
        'workspace-bound. A cross-lane (global) retract is an owner-only ' +
        'workspace action (SoT-050).',
    );
  }
  let role = cached.role;
  try {
    const fresh = await refreshWorkspaceBinding(projectId, params);
    if (!fresh) {
      throw new Error(
        `workspace ${cached.workspaceId} no longer lists this account ` +
          '(membership revoked or workspace deleted)',
      );
    }
    role = fresh.role;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no longer lists this account/.test(message)) throw error;
    process.stderr.write(
      `WARN: could not refresh workspace role from the Hub (${message}); ` +
        `using the cached role '${cached.role}'.\n`,
    );
  }
  if (role !== 'owner') {
    throw new Error(
      'Only a workspace owner may retract another writer\'s memory ' +
        `(your role: '${role}', SoT-040/050, Hub H030).`,
    );
  }
  return 'owner';
}

/**
 * Persist the `wsp_` binding into the project's sync state. `remoteProjectId`
 * carries the opaque `wsp_` (never validated against the client ID_PATTERN);
 * `workspaceRole` + `inviteReachable` are the control-plane cache. Also persists
 * the http `syncTransport` (W-b): the bind already knows the Hub URL, so a bound
 * workspace is immediately flag-less-syncable and auto-sync eligible — the union
 * data-plane is the EXISTING events route keyed by the `wsp_` remoteProjectId.
 */
async function writeWorkspaceBinding(
  projectId: string,
  remoteUrl: string,
  workspace: { workspaceId: string; role: WorkspaceRole; inviteReachable: boolean },
): Promise<void> {
  const syncFile = getSyncFile(projectId);
  const existing = await readJson<ProjectSyncState>(syncFile);
  const now = nowIso();
  const patch = {
    remoteProjectId: workspace.workspaceId,
    workspaceRole: workspace.role,
    inviteReachable: workspace.inviteReachable,
    syncEnabled: true,
    syncTransport: { type: 'http' as const, url: remoteUrl },
    updatedAt: now,
  };
  if (!existing) {
    const state: ProjectSyncState = {
      id: `sync_${projectId}`,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: now,
      projectId,
      syncStatus: 'idle',
      ...patch,
    };
    await writeJson(syncFile, state);
    return;
  }
  await writeJson(syncFile, { ...existing, ...patch });
}
