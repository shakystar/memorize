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
