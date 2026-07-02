import type {
  SyncPullRequest,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
} from '../domain/sync-protocol.js';
import type { SyncTransport } from '../domain/sync-transport.js';

/**
 * P3-b-2 — HTTP relay client transport. The network sibling of the file
 * transport (sync-transport-file.ts): for machines that do NOT share a
 * filesystem, events flow through an OPTIONAL relay server (built separately in
 * the `memorize_hub` repo). Store-and-forward, same as file — the origin pushes,
 * the relay holds, a replica pulls later. The wire contract is documented in
 * `memorize_hub/PROTOCOL.md` (the shared source of truth both sides implement):
 *
 *   POST {baseUrl}/v1/projects/{remoteProjectId}/events   body=SyncPushRequest  -> SyncPushResponse
 *   GET  {baseUrl}/v1/projects/{remoteProjectId}/events?since={id}             -> SyncPullResponse
 *
 * Events are opaque DomainEvent JSON — the relay never parses or validates them,
 * only preserves order. Dedup-by-id at the relay is RECOMMENDED but the client
 * tolerates duplicates regardless (local `insertExternalEvents` is INSERT OR
 * IGNORE). Non-2xx throws; auto-sync-service's never-throw gate degrades it to a
 * deferred no-op, exactly like a file transport failure.
 */

export interface HttpSyncTransportOptions {
  /** Optional bearer token. Sent as `Authorization: Bearer <token>` when set. */
  token?: string;
  /** Injectable fetch (tests). Defaults to the global `fetch` (Node >= 18). */
  fetchImpl?: typeof fetch;
}

function projectEventsUrl(baseUrl: string, remoteProjectId: string): string {
  // Trim a trailing slash so `${base}/v1/...` never doubles up.
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/v1/projects/${encodeURIComponent(remoteProjectId)}/events`;
}

/**
 * Outcome of a cheap pre-flight auth probe (#192). `'ok'` = the Hub accepted the
 * token; `'unauthorized'` = it rejected it (the only fail-fast signal); for
 * anything else (`'unreachable'`) we cannot conclude and the caller degrades to
 * "store anyway".
 */
export type HubAuthProbe = 'ok' | 'unauthorized' | 'unreachable';

/**
 * Validate a bearer token against the Hub before storing it (#192 — `auth
 * login`'s fail-fast check). A project-INDEPENDENT `GET {base}/healthz` carrying
 * `Authorization: Bearer <token>`: per the wire contract (the in-repo reference
 * relay `tests/harness/relay-stub.ts` gates EVERY route, /healthz included), a
 * `401`/`403` means the credentials were rejected — and only that. We
 * deliberately do NOT probe a project-scoped endpoint, where a `401`/`403`/`404`
 * could instead mean project ownership/existence and cause a false hard-fail.
 *
 * Returns `'unauthorized'` ONLY on `401`/`403`; `'ok'` on any 2xx; and
 * `'unreachable'` for any other status, or a thrown fetch (offline / DNS / a Hub
 * that doesn't gate or expose /healthz). The caller hard-fails on
 * `'unauthorized'` and stores-with-a-note otherwise.
 */
export async function probeHubAuth(
  baseUrl: string,
  token: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<HubAuthProbe> {
  const doFetch = options.fetchImpl ?? fetch;
  const base = baseUrl.replace(/\/+$/, '');
  try {
    const response = await doFetch(`${base}/healthz`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.status === 401 || response.status === 403) {
      return 'unauthorized';
    }
    return response.ok ? 'ok' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

/**
 * Browser device-authorization grant (RFC 8628 shaped) — the client half of
 * `docs/protocol/device-auth.md` in memorize_hub. Replaces bring-your-own-token
 * login: instead of pasting a key, the CLI starts a grant here, the human
 * approves it in a browser signed in to their account, and the Hub mints an
 * `mzk_` key the CLI polls for. These two endpoints are UNAUTHENTICATED — the CLI
 * has no key yet; the `device_code` is itself the bearer of the pending grant.
 */
export interface DeviceCodeResponse {
  /** Opaque client-held secret; the poll bearer. */
  deviceCode: string;
  /** Short human-transcribable code shown in the terminal and confirmed in-browser. */
  userCode: string;
  /** Where the human goes to approve. */
  verificationUri: string;
  /** Same, with `user_code` pre-filled (what we open in a browser). */
  verificationUriComplete: string;
  /** Grant TTL in seconds — the overall poll deadline. */
  expiresIn: number;
  /** Minimum seconds between polls. */
  interval: number;
}

/** Start a device grant. `POST /v1/device/code` (no auth). Throws on a non-2xx. */
export async function requestDeviceCode(
  baseUrl: string,
  options: { label?: string; fetchImpl?: typeof fetch } = {},
): Promise<DeviceCodeResponse> {
  const doFetch = options.fetchImpl ?? fetch;
  const base = baseUrl.replace(/\/+$/, '');
  const response = await doFetch(`${base}/v1/device/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(options.label ? { label: options.label } : {}),
  });
  if (!response.ok) {
    throw new Error(
      `Could not start browser login at ${base} (${response.status}).`,
    );
  }
  const body = (await response.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
  };
  if (!body.device_code || !body.user_code || !body.verification_uri) {
    throw new Error(`Malformed device-code response from ${base}.`);
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    verificationUriComplete:
      body.verification_uri_complete ?? body.verification_uri,
    expiresIn: body.expires_in ?? 600,
    interval: body.interval ?? 5,
  };
}

/**
 * One poll of `POST /v1/device/token` (no auth). Per the contract the not-yet-done
 * cases come back as `400 { error: … }`, so — unlike the sync transport — this
 * MUST NOT throw-on-non-2xx: it reads the RFC-8628 error string out of the 400
 * body and maps it to a status the caller's loop can act on. Only an unexpected
 * status/shape throws.
 */
export type DeviceTokenPoll =
  | { status: 'authorization_pending' }
  | { status: 'slow_down' }
  | { status: 'expired_token' }
  | { status: 'access_denied' }
  | { status: 'approved'; token: string; tokenId?: string; label?: string };

export async function pollDeviceTokenOnce(
  baseUrl: string,
  deviceCode: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<DeviceTokenPoll> {
  const doFetch = options.fetchImpl ?? fetch;
  const base = baseUrl.replace(/\/+$/, '');
  const response = await doFetch(`${base}/v1/device/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_code: deviceCode }),
  });
  if (response.ok) {
    const body = (await response.json()) as {
      token?: string;
      tokenId?: string;
      label?: string;
    };
    if (!body.token) {
      throw new Error(`Approved device poll returned no token from ${base}.`);
    }
    return {
      status: 'approved',
      token: body.token,
      ...(body.tokenId ? { tokenId: body.tokenId } : {}),
      ...(body.label ? { label: body.label } : {}),
    };
  }
  if (response.status === 400) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    switch (body.error) {
      case 'authorization_pending':
      case 'slow_down':
      case 'expired_token':
      case 'access_denied':
        return { status: body.error };
      default:
        throw new Error(
          `Browser login was rejected: ${body.error ?? 'unknown error'}.`,
        );
    }
  }
  throw new Error(`Browser login poll failed (${response.status}).`);
}

export function createHttpSyncTransport(
  baseUrl: string,
  options: HttpSyncTransportOptions = {},
): SyncTransport {
  const doFetch = options.fetchImpl ?? fetch;
  const authHeader: Record<string, string> = options.token
    ? { authorization: `Bearer ${options.token}` }
    : {};

  async function readError(response: Response, action: string): Promise<never> {
    let body = '';
    try {
      body = await response.text();
    } catch {
      // Body already consumed / unreadable — status alone is enough to report.
    }
    const detail = body ? `: ${body.slice(0, 200)}` : '';
    throw new Error(
      `HTTP relay ${action} failed (${response.status} ${response.statusText})${detail}`,
    );
  }

  return {
    async push(request: SyncPushRequest): Promise<SyncPushResponse> {
      const remoteProjectId = request.remoteProjectId ?? request.projectId;
      const response = await doFetch(
        projectEventsUrl(baseUrl, remoteProjectId),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeader },
          body: JSON.stringify(request),
        },
      );
      if (!response.ok) return readError(response, 'push');
      return (await response.json()) as SyncPushResponse;
    },

    async pull(request: SyncPullRequest): Promise<SyncPullResponse> {
      const url = new URL(projectEventsUrl(baseUrl, request.remoteProjectId));
      if (request.sincePulledEventId) {
        url.searchParams.set('since', request.sincePulledEventId);
      }
      const response = await doFetch(url, {
        method: 'GET',
        headers: { ...authHeader },
      });
      if (!response.ok) return readError(response, 'pull');
      return (await response.json()) as SyncPullResponse;
    },
  };
}

/**
 * Resolve the calling account's personal-store id from the Hub
 * (`GET /v1/account/personal-store`; Hub SoT H050 / docs/protocol/personal-store.md),
 * server-provisioning one on first call. The returned `storeId` is a server-minted
 * `psm_…` — an OPAQUE routing id in the Hub namespace (`[A-Za-z0-9_-]`, uppercase
 * allowed), NOT a local `proj_`/`personal_…` id, so it MUST NOT be validated
 * against the client's lowercase ID_PATTERN. It travels only as the events-route
 * path component and as `remoteProjectId` in sync state. Requires an UNSCOPED key.
 */
export async function resolvePersonalStore(
  baseUrl: string,
  token: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<{ storeId: string; eventsUrl: string }> {
  const doFetch = options.fetchImpl ?? fetch;
  const base = baseUrl.replace(/\/+$/, '');
  const response = await doFetch(`${base}/v1/account/personal-store`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    let body = '';
    try {
      body = await response.text();
    } catch {
      // Status alone is enough to report.
    }
    throw new Error(
      `Personal-store discovery failed (${response.status} ${response.statusText})` +
        (body ? `: ${body.slice(0, 200)}` : ''),
    );
  }
  return (await response.json()) as { storeId: string; eventsUrl: string };
}

/**
 * Workspace control-plane client (Hub SoT H010/H040, docs/protocol/workspace.md).
 * `wsp_` identity, role, and membership are CONTROL-PLANE facts served by the
 * gateway — never domain events (memorize SoT-022). Like `psm_`, a `wsp_` is a
 * server-minted OPAQUE id (`[A-Za-z0-9_-]`, uppercase allowed) and MUST NOT be
 * validated against the client's lowercase ID_PATTERN; it travels only as the
 * events-route path component and as `remoteProjectId` in sync state. All three
 * calls require an UNSCOPED bearer key.
 */
export type WorkspaceRole = 'owner' | 'member';

export interface WorkspaceResolution {
  /** Server-minted opaque `wsp_…`. */
  workspaceId: string;
  eventsUrl: string;
  role: WorkspaceRole;
  inviteReachable: boolean;
}

export interface WorkspaceListEntry extends WorkspaceResolution {
  name: string | null;
  memberCount: number;
}

export interface WorkspaceMember {
  accountId: string;
  role: WorkspaceRole;
  email: string;
  joinedAt: string;
}

export interface WorkspaceRoster {
  workspaceId: string;
  name: string | null;
  inviteReachable: boolean;
  members: WorkspaceMember[];
}

/** Shared control-plane error reader: status + a short body snippet. */
async function throwControlPlaneError(
  response: Response,
  action: string,
): Promise<never> {
  let body = '';
  try {
    body = await response.text();
  } catch {
    // Status alone is enough to report.
  }
  throw new Error(
    `Workspace ${action} failed (${response.status} ${response.statusText})` +
      (body ? `: ${body.slice(0, 200)}` : ''),
  );
}

/**
 * Create a workspace — the caller becomes its sole `owner` and the store starts
 * `inviteReachable:false` (a private project; store-resolution.md). `POST /v1/workspaces`.
 */
export async function createWorkspace(
  baseUrl: string,
  token: string,
  options: { name?: string; fetchImpl?: typeof fetch } = {},
): Promise<WorkspaceResolution> {
  const doFetch = options.fetchImpl ?? fetch;
  const base = baseUrl.replace(/\/+$/, '');
  const response = await doFetch(`${base}/v1/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(options.name ? { name: options.name } : {}),
  });
  if (!response.ok) return throwControlPlaneError(response, 'create');
  return (await response.json()) as WorkspaceResolution;
}

/**
 * List the workspaces the calling account belongs to (includes 1-member private
 * projects). Used to ADOPT an existing `wsp_` instead of minting a duplicate.
 * `GET /v1/account/workspaces`.
 */
export async function listWorkspaces(
  baseUrl: string,
  token: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<WorkspaceListEntry[]> {
  const doFetch = options.fetchImpl ?? fetch;
  const base = baseUrl.replace(/\/+$/, '');
  const response = await doFetch(`${base}/v1/account/workspaces`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) return throwControlPlaneError(response, 'discovery');
  const body = (await response.json()) as { workspaces?: WorkspaceListEntry[] };
  return body.workspaces ?? [];
}

/**
 * Read the membership roster — co-writers + their roles — so the client can label
 * shared-memory provenance and refresh its cached role. `GET /v1/workspaces/:id`.
 */
export async function getWorkspaceRoster(
  baseUrl: string,
  token: string,
  workspaceId: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<WorkspaceRoster> {
  const doFetch = options.fetchImpl ?? fetch;
  const base = baseUrl.replace(/\/+$/, '');
  const response = await doFetch(
    `${base}/v1/workspaces/${encodeURIComponent(workspaceId)}`,
    { method: 'GET', headers: { authorization: `Bearer ${token}` } },
  );
  if (!response.ok) return throwControlPlaneError(response, 'roster');
  return (await response.json()) as WorkspaceRoster;
}

export interface WorkspaceInvite {
  inviteId: string;
  /** The join capability — shown ONCE at mint, never re-served by the Hub. */
  token: string;
  joinUrl: string;
  role: 'member';
  maxUses: number | null;
  expiresAt: string | null;
}

/**
 * Owner mints a revocable, multi-use invite (always grants `member`; promotion
 * is a later role change). The FIRST successful mint flips the store to
 * `inviteReachable:true` on the Hub — private project -> shared workspace.
 * `POST /v1/workspaces/:id/invites`.
 */
export async function mintWorkspaceInvite(
  baseUrl: string,
  token: string,
  workspaceId: string,
  options: {
    maxUses?: number;
    expiresAt?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<WorkspaceInvite> {
  const doFetch = options.fetchImpl ?? fetch;
  const base = baseUrl.replace(/\/+$/, '');
  const response = await doFetch(
    `${base}/v1/workspaces/${encodeURIComponent(workspaceId)}/invites`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ...(options.maxUses !== undefined ? { maxUses: options.maxUses } : {}),
        ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
      }),
    },
  );
  if (!response.ok) return throwControlPlaneError(response, 'invite');
  return (await response.json()) as WorkspaceInvite;
}

/**
 * Redeem an invite token for the calling account (become a `member`). Idempotent
 * on the Hub: an already-member join returns the existing membership without
 * consuming a use. Dead tokens (revoked/expired/exhausted) -> `403`.
 * `POST /v1/workspaces/join`.
 */
export async function joinWorkspaceRemote(
  baseUrl: string,
  token: string,
  inviteToken: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<{ workspaceId: string; eventsUrl: string; role: WorkspaceRole }> {
  const doFetch = options.fetchImpl ?? fetch;
  const base = baseUrl.replace(/\/+$/, '');
  const response = await doFetch(`${base}/v1/workspaces/join`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ token: inviteToken }),
  });
  if (!response.ok) return throwControlPlaneError(response, 'join');
  return (await response.json()) as {
    workspaceId: string;
    eventsUrl: string;
    role: WorkspaceRole;
  };
}

/**
 * Owner changes a member's role (W-c) — promote `member` -> `owner` (also how
 * ownership is transferred), or demote. Demoting the sole remaining owner is a
 * Hub-side `409` (last-owner invariant). `PATCH /v1/workspaces/:id/members/:accountId`.
 */
export async function setWorkspaceMemberRole(
  baseUrl: string,
  token: string,
  workspaceId: string,
  accountId: string,
  role: WorkspaceRole,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<{ accountId: string; role: WorkspaceRole }> {
  const doFetch = options.fetchImpl ?? fetch;
  const base = baseUrl.replace(/\/+$/, '');
  const response = await doFetch(
    `${base}/v1/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(accountId)}`,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ role }),
    },
  );
  if (!response.ok) return throwControlPlaneError(response, 'role change');
  return (await response.json()) as { accountId: string; role: WorkspaceRole };
}

/**
 * Remove a member (owner removing anyone, or any member removing themselves —
 * self-leave). Removing the sole remaining owner while other members exist is a
 * Hub-side `409`. Removal revokes future access; already-pulled bytes are not
 * recallable (SoT-040/050). `DELETE /v1/workspaces/:id/members/:accountId` -> `204`.
 */
export async function removeWorkspaceMember(
  baseUrl: string,
  token: string,
  workspaceId: string,
  accountId: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const doFetch = options.fetchImpl ?? fetch;
  const base = baseUrl.replace(/\/+$/, '');
  const response = await doFetch(
    `${base}/v1/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(accountId)}`,
    { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
  );
  if (!response.ok) return throwControlPlaneError(response, 'member removal');
}
