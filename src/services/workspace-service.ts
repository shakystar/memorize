import {
  createWorkspace,
  joinWorkspaceRemote,
  mintWorkspaceInvite,
  type WorkspaceInvite,
  type WorkspaceRole,
} from '../adapters/sync-transport-http.js';
import { CURRENT_SCHEMA_VERSION, nowIso } from '../domain/common.js';
import type { ProjectSyncState } from '../domain/entities.js';
import { readToken } from '../storage/credentials-store.js';
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
  const syncFile = getSyncFile(projectId);
  const state = await readJson<ProjectSyncState>(syncFile);
  if (!state?.remoteProjectId || !state.workspaceRole) {
    throw new Error(
      'Project is not workspace-bound. Run `memorize workspace create` first.',
    );
  }
  // The bind persisted the Hub URL as the http transport; an explicit flag wins.
  const remoteUrl =
    params.remoteUrl ??
    (state.syncTransport?.type === 'http' ? state.syncTransport.url : undefined);
  if (!remoteUrl) {
    throw new Error('No Hub URL known for this workspace. Pass --remote-url.');
  }
  const token = await readToken(remoteUrl);
  if (!token) {
    throw new Error(
      `No stored credential for ${remoteUrl}. Run ` +
        `\`memorize auth login --remote-url ${remoteUrl}\` first.`,
    );
  }
  const invite = await mintWorkspaceInvite(remoteUrl, token, state.remoteProjectId, {
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
