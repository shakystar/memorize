import {
  createWorkspace,
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
  await writeWorkspaceBinding(projectId, workspace);
  return {
    workspaceId: workspace.workspaceId,
    role: workspace.role,
    inviteReachable: workspace.inviteReachable,
    created: true,
  };
}

/**
 * Persist the `wsp_` binding into the project's sync state. `remoteProjectId`
 * carries the opaque `wsp_` (never validated against the client ID_PATTERN);
 * `workspaceRole` + `inviteReachable` are the control-plane cache. Does NOT set a
 * `syncTransport` — the actual union sync (and thus auto-sync eligibility) is W-b.
 */
async function writeWorkspaceBinding(
  projectId: string,
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
