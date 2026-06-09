/**
 * In-test reference relay implementing the P3-b-2 HTTP wire contract
 * (memorize_hub/PROTOCOL.md). TEST-ONLY — not shipped. It lets the client
 * transport (src/adapters/sync-transport-http.ts) round-trip against a real
 * `node:http` server on an ephemeral port, proving the client speaks the
 * contract before the real `memorize_hub` server exists.
 *
 * Storage = in-memory per-project ordered log + a seen-id set (store-and-forward
 * with idempotent dedup-by-id). Optional bearer token gates every route.
 *
 *   POST /v1/projects/:id/events   body=SyncPushRequest  -> SyncPushResponse
 *   GET  /v1/projects/:id/events?since={id}              -> SyncPullResponse
 *   GET  /healthz                                        -> { ok: true }
 */
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { AddressInfo } from 'node:net';

import type { DomainEvent } from '../../src/domain/events.js';
import type {
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
} from '../../src/domain/sync-protocol.js';

export interface RelayStub {
  baseUrl: string;
  /** Raw events the relay holds for a project (insertion order). */
  events(projectId: string): DomainEvent[];
  close(): Promise<void>;
}

const PROJECT_EVENTS = /^\/v1\/projects\/([^/]+)\/events$/;

async function readBody(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function startRelayStub(
  options: { token?: string } = {},
): Promise<RelayStub> {
  // projectId -> ordered events, plus a seen-id set for idempotent dedup.
  const logs = new Map<string, DomainEvent[]>();
  const seen = new Map<string, Set<string>>();

  const logFor = (id: string): DomainEvent[] => {
    let log = logs.get(id);
    if (!log) {
      log = [];
      logs.set(id, log);
      seen.set(id, new Set());
    }
    return log;
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const send = (status: number, body: unknown): void => {
        const json = JSON.stringify(body);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(json);
      };

      // Optional bearer-token gate (applies to every route when configured).
      if (options.token) {
        const auth = req.headers.authorization;
        if (auth !== `Bearer ${options.token}`) {
          send(401, { error: 'unauthorized' });
          return;
        }
      }

      const url = new URL(req.url ?? '/', 'http://relay.local');
      if (req.method === 'GET' && url.pathname === '/healthz') {
        send(200, { ok: true });
        return;
      }

      const match = PROJECT_EVENTS.exec(url.pathname);
      if (!match) {
        send(404, { error: 'not found' });
        return;
      }
      const projectId = decodeURIComponent(match[1]!);

      if (req.method === 'POST') {
        const request = JSON.parse(await readBody(req)) as SyncPushRequest;
        const log = logFor(projectId);
        const seenIds = seen.get(projectId)!;
        const accepted: string[] = [];
        for (const event of request.events ?? []) {
          if (seenIds.has(event.id)) continue; // idempotent dedup-by-id
          seenIds.add(event.id);
          log.push(event);
          accepted.push(event.id);
        }
        const lastAcceptedEventId = accepted[accepted.length - 1];
        const response: SyncPushResponse = {
          accepted,
          rejected: [],
          ...(lastAcceptedEventId ? { lastAcceptedEventId } : {}),
        };
        send(200, response);
        return;
      }

      if (req.method === 'GET') {
        const log = logFor(projectId);
        const since = url.searchParams.get('since');
        // Unknown `since` id -> return all (mirrors the file adapter's
        // findIndex(-1)+1 = slice(0) behavior; client dedups regardless).
        const sliceStart = since
          ? log.findIndex((event) => event.id === since) + 1
          : 0;
        const pending = sliceStart > 0 ? log.slice(sliceStart) : log;
        const lastRemoteEventId = pending[pending.length - 1]?.id;
        const response: SyncPullResponse = {
          events: pending,
          ...(lastRemoteEventId ? { lastRemoteEventId } : {}),
        };
        send(200, response);
        return;
      }

      send(404, { error: 'not found' });
    })().catch((error: unknown) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    events: (projectId: string) => logs.get(projectId) ?? [],
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}
