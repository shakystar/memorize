import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createHttpSyncTransport,
  probeHubAuth,
} from '../../src/adapters/sync-transport-http.js';
import type { DomainEvent } from '../../src/domain/events.js';
import { startRelayStub, type RelayStub } from '../harness/relay-stub.js';

function makeEvent(id: string): DomainEvent {
  return {
    id,
    schemaVersion: 1,
    type: 'task.created',
    projectId: 'proj_http',
    scopeType: 'task',
    scopeId: id,
    actor: 'user',
    createdAt: '2026-06-08T00:00:00.000Z',
    payload: { title: id },
  } as unknown as DomainEvent;
}

let relay: RelayStub;

afterEach(async () => {
  await relay?.close();
});

describe('http SyncTransport client (P3-b-2)', () => {
  beforeEach(async () => {
    relay = await startRelayStub();
  });

  it('pushes events and pulls them back in order', async () => {
    const transport = createHttpSyncTransport(relay.baseUrl);
    const push = await transport.push({
      projectId: 'proj_http',
      events: [makeEvent('evt_a'), makeEvent('evt_b')],
    });
    expect(push.accepted).toEqual(['evt_a', 'evt_b']);
    expect(push.lastAcceptedEventId).toBe('evt_b');

    const pull = await transport.pull({
      projectId: 'proj_http',
      remoteProjectId: 'proj_http',
    });
    expect(pull.events.map((e) => e.id)).toEqual(['evt_a', 'evt_b']);
    expect(pull.lastRemoteEventId).toBe('evt_b');
  });

  it('slices on the since watermark', async () => {
    const transport = createHttpSyncTransport(relay.baseUrl);
    await transport.push({
      projectId: 'proj_http',
      events: [makeEvent('evt_a'), makeEvent('evt_b'), makeEvent('evt_c')],
    });
    const pull = await transport.pull({
      projectId: 'proj_http',
      remoteProjectId: 'proj_http',
      sincePulledEventId: 'evt_a',
    });
    expect(pull.events.map((e) => e.id)).toEqual(['evt_b', 'evt_c']);
  });

  it('is idempotent — re-pushing the same ids is deduped at the relay', async () => {
    const transport = createHttpSyncTransport(relay.baseUrl);
    await transport.push({
      projectId: 'proj_http',
      events: [makeEvent('evt_a'), makeEvent('evt_b')],
    });
    // Overlapping re-push (e.g. a stale watermark) accepts only the new id.
    const second = await transport.push({
      projectId: 'proj_http',
      events: [makeEvent('evt_b'), makeEvent('evt_c')],
    });
    expect(second.accepted).toEqual(['evt_c']);
    expect(relay.events('proj_http').map((e) => e.id)).toEqual([
      'evt_a',
      'evt_b',
      'evt_c',
    ]);
  });

  it('routes by remoteProjectId, not the local projectId', async () => {
    const transport = createHttpSyncTransport(relay.baseUrl);
    await transport.push({
      projectId: 'local_id',
      remoteProjectId: 'remote_id',
      events: [makeEvent('evt_a')],
    });
    expect(relay.events('remote_id').map((e) => e.id)).toEqual(['evt_a']);
    expect(relay.events('local_id')).toEqual([]);
  });

  it('throws on a non-2xx response (gate degrades it upstream)', async () => {
    const transport = createHttpSyncTransport(`${relay.baseUrl}/nope`);
    await expect(
      transport.pull({ projectId: 'p', remoteProjectId: 'p' }),
    ).rejects.toThrow(/relay pull failed \(404/);
  });

  it('throws on a network error (no server)', async () => {
    // Port 0 is unconnectable; the global fetch rejects.
    const transport = createHttpSyncTransport('http://127.0.0.1:1');
    await expect(
      transport.push({ projectId: 'p', events: [makeEvent('evt_a')] }),
    ).rejects.toBeTruthy();
  });
});

describe('http SyncTransport — optional bearer token', () => {
  beforeEach(async () => {
    relay = await startRelayStub({ token: 'secret-123' });
  });

  it('accepts requests carrying the matching token', async () => {
    const transport = createHttpSyncTransport(relay.baseUrl, {
      token: 'secret-123',
    });
    const push = await transport.push({
      projectId: 'proj_http',
      events: [makeEvent('evt_a')],
    });
    expect(push.accepted).toEqual(['evt_a']);
  });

  it('throws 401 when the token is missing or wrong', async () => {
    const noToken = createHttpSyncTransport(relay.baseUrl);
    await expect(
      noToken.pull({ projectId: 'proj_http', remoteProjectId: 'proj_http' }),
    ).rejects.toThrow(/401/);

    const wrongToken = createHttpSyncTransport(relay.baseUrl, {
      token: 'wrong',
    });
    await expect(
      wrongToken.push({ projectId: 'proj_http', events: [makeEvent('x')] }),
    ).rejects.toThrow(/401/);
  });
});

describe('probeHubAuth (#192 — auth login fail-fast)', () => {
  it('returns "ok" for a token the Hub accepts', async () => {
    relay = await startRelayStub({ token: 'good' });
    expect(await probeHubAuth(relay.baseUrl, 'good')).toBe('ok');
  });

  it('returns "ok" against a tokenless (open) Hub', async () => {
    relay = await startRelayStub();
    expect(await probeHubAuth(relay.baseUrl, 'anything')).toBe('ok');
  });

  it('returns "unauthorized" when the Hub rejects the token (401)', async () => {
    relay = await startRelayStub({ token: 'good' });
    expect(await probeHubAuth(relay.baseUrl, 'wrong')).toBe('unauthorized');
  });

  it('returns "unauthorized" on a 403 (injected fetch)', async () => {
    const fetchImpl = (async () =>
      new Response('forbidden', { status: 403 })) as unknown as typeof fetch;
    expect(
      await probeHubAuth('https://hub.example', 'x', { fetchImpl }),
    ).toBe('unauthorized');
  });

  it('returns "unreachable" on a non-2xx, non-auth status', async () => {
    const fetchImpl = (async () =>
      new Response('boom', { status: 500 })) as unknown as typeof fetch;
    expect(
      await probeHubAuth('https://hub.example', 'x', { fetchImpl }),
    ).toBe('unreachable');
  });

  it('returns "unreachable" when fetch throws (offline/DNS)', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(
      await probeHubAuth('https://hub.example', 'x', { fetchImpl }),
    ).toBe('unreachable');
  });
});
