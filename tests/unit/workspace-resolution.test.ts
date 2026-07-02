import { describe, expect, it } from 'vitest';

import {
  createWorkspace,
  getWorkspaceRoster,
  joinWorkspaceRemote,
  listWorkspaces,
  mintWorkspaceInvite,
} from '../../src/adapters/sync-transport-http.js';

function fakeFetch(response: {
  ok: boolean;
  status: number;
  statusText?: string;
  json?: unknown;
  text?: string;
}): typeof fetch {
  return (async () => ({
    ok: response.ok,
    status: response.status,
    statusText: response.statusText ?? '',
    json: async () => response.json,
    text: async () => response.text ?? '',
  })) as unknown as typeof fetch;
}

/** Captures the request so we can assert method/url/headers/body. */
function capturingFetch(
  captured: { url?: string; init?: RequestInit },
  response: { ok: boolean; status: number; json?: unknown },
): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    captured.url = url;
    captured.init = init;
    return {
      ok: response.ok,
      status: response.status,
      statusText: '',
      json: async () => response.json,
      text: async () => '',
    };
  }) as unknown as typeof fetch;
}

describe('createWorkspace (POST /v1/workspaces)', () => {
  it('returns the server-minted opaque wsp_ as an owner-created private project', async () => {
    const result = await createWorkspace('https://hub.test/', 'tok', {
      name: 'Team',
      fetchImpl: fakeFetch({
        ok: true,
        status: 201,
        json: {
          workspaceId: 'wsp_9Abc-Def',
          eventsUrl: '/v1/projects/wsp_9Abc-Def/events',
          role: 'owner',
          inviteReachable: false,
        },
      }),
    });
    // Uppercase + dash: a Hub-namespace id, never validated against the client's
    // lowercase ID_PATTERN.
    expect(result.workspaceId).toBe('wsp_9Abc-Def');
    expect(result.role).toBe('owner');
    expect(result.inviteReachable).toBe(false);
  });

  it('POSTs with an unscoped bearer and the name in the body', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    await createWorkspace('https://hub.test', 'tok', {
      name: 'Team',
      fetchImpl: capturingFetch(captured, {
        ok: true,
        status: 201,
        json: {
          workspaceId: 'wsp_x',
          eventsUrl: '/v1/projects/wsp_x/events',
          role: 'owner',
          inviteReachable: false,
        },
      }),
    });
    expect(captured.url).toBe('https://hub.test/v1/workspaces');
    expect(captured.init?.method).toBe('POST');
    expect(
      (captured.init?.headers as Record<string, string>).authorization,
    ).toBe('Bearer tok');
    expect(JSON.parse(captured.init?.body as string)).toEqual({ name: 'Team' });
  });

  it('throws with the status on a non-2xx (e.g. read_only key → 403)', async () => {
    await expect(
      createWorkspace('https://hub.test', 'tok', {
        fetchImpl: fakeFetch({
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          text: '{"error":"read_only"}',
        }),
      }),
    ).rejects.toThrow(/403/);
  });
});

describe('listWorkspaces (GET /v1/account/workspaces)', () => {
  it('returns the discovery list (private + shared)', async () => {
    const list = await listWorkspaces('https://hub.test', 'tok', {
      fetchImpl: fakeFetch({
        ok: true,
        status: 200,
        json: {
          workspaces: [
            {
              workspaceId: 'wsp_a',
              eventsUrl: '/v1/projects/wsp_a/events',
              role: 'owner',
              name: null,
              inviteReachable: false,
              memberCount: 1,
            },
          ],
        },
      }),
    });
    expect(list).toHaveLength(1);
    expect(list[0]?.workspaceId).toBe('wsp_a');
  });

  it('tolerates a missing/empty workspaces array', async () => {
    const list = await listWorkspaces('https://hub.test', 'tok', {
      fetchImpl: fakeFetch({ ok: true, status: 200, json: {} }),
    });
    expect(list).toEqual([]);
  });
});

describe('getWorkspaceRoster (GET /v1/workspaces/:id)', () => {
  it('returns the members with roles and encodes the opaque id in the path', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const roster = await getWorkspaceRoster('https://hub.test', 'tok', 'wsp_9Abc-Def', {
      fetchImpl: capturingFetch(captured, {
        ok: true,
        status: 200,
        json: {
          workspaceId: 'wsp_9Abc-Def',
          name: 'Team',
          inviteReachable: true,
          members: [
            { accountId: 'acc_1', role: 'owner', email: 'a@x.com', joinedAt: 't' },
          ],
        },
      }),
    });
    expect(captured.url).toBe('https://hub.test/v1/workspaces/wsp_9Abc-Def');
    expect(roster.members[0]?.role).toBe('owner');
  });

  it('throws with the status when the caller is a non-member (404)', async () => {
    await expect(
      getWorkspaceRoster('https://hub.test', 'tok', 'wsp_x', {
        fetchImpl: fakeFetch({ ok: false, status: 404, statusText: 'Not Found' }),
      }),
    ).rejects.toThrow(/404/);
  });
});

describe('mintWorkspaceInvite (POST /v1/workspaces/:id/invites)', () => {
  it('POSTs the policy body and returns the one-shot token + joinUrl', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const invite = await mintWorkspaceInvite('https://hub.test', 'tok', 'wsp_9Abc-Def', {
      maxUses: 2,
      expiresAt: '2026-07-09T00:00:00Z',
      fetchImpl: capturingFetch(captured, {
        ok: true,
        status: 201,
        json: {
          inviteId: 'inv_1',
          token: 'join-secret',
          joinUrl: 'https://hub.test/join?token=join-secret',
          role: 'member',
          maxUses: 2,
          expiresAt: '2026-07-09T00:00:00Z',
        },
      }),
    });
    expect(captured.url).toBe('https://hub.test/v1/workspaces/wsp_9Abc-Def/invites');
    expect(captured.init?.method).toBe('POST');
    expect(JSON.parse(captured.init?.body as string)).toEqual({
      maxUses: 2,
      expiresAt: '2026-07-09T00:00:00Z',
    });
    expect(invite.token).toBe('join-secret');
    expect(invite.role).toBe('member');
  });

  it('throws with the status when a non-owner mints (403)', async () => {
    await expect(
      mintWorkspaceInvite('https://hub.test', 'tok', 'wsp_x', {
        fetchImpl: fakeFetch({ ok: false, status: 403, statusText: 'Forbidden' }),
      }),
    ).rejects.toThrow(/403/);
  });
});

describe('joinWorkspaceRemote (POST /v1/workspaces/join)', () => {
  it('redeems the invite token and returns the membership shape', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const joined = await joinWorkspaceRemote('https://hub.test', 'tok', 'join-secret', {
      fetchImpl: capturingFetch(captured, {
        ok: true,
        status: 200,
        json: {
          workspaceId: 'wsp_9Abc-Def',
          eventsUrl: '/v1/projects/wsp_9Abc-Def/events',
          role: 'member',
        },
      }),
    });
    expect(captured.url).toBe('https://hub.test/v1/workspaces/join');
    expect(JSON.parse(captured.init?.body as string)).toEqual({ token: 'join-secret' });
    expect(joined.workspaceId).toBe('wsp_9Abc-Def');
    expect(joined.role).toBe('member');
  });

  it('throws with the status on a dead token (403)', async () => {
    await expect(
      joinWorkspaceRemote('https://hub.test', 'tok', 'stale', {
        fetchImpl: fakeFetch({ ok: false, status: 403, statusText: 'Forbidden' }),
      }),
    ).rejects.toThrow(/403/);
  });
});
