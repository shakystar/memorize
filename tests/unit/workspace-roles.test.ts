import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setToken } from '../../src/storage/credentials-store.js';
import {
  bindWorkspace,
  changeWorkspaceMemberRole,
  getWorkspaceBinding,
  listWorkspaceMembers,
  refreshWorkspaceBinding,
  removeMemberFromWorkspace,
  requireOwnerForGlobalRetract,
} from '../../src/services/workspace-service.js';

const projectId = 'proj_ws_roles_test';
const remoteUrl = 'https://hub.test';
const wsp = 'wsp_RolesAbc';

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'memorize-wsroles-'));
  process.env.MEMORIZE_ROOT = sandbox;
  await setToken(remoteUrl, 'tok');
});

afterEach(async () => {
  delete process.env.MEMORIZE_ROOT;
  await rm(sandbox, { recursive: true, force: true });
});

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status < 400,
    status,
    statusText: '',
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Route-matching fetch stub: [method, url-substring] -> response body. */
function fetchRouter(
  routes: Array<[string, string, number, unknown]>,
): typeof fetch {
  return (async (url: unknown, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    const target = String(url);
    for (const [m, part, status, body] of routes) {
      if (m === method && target.includes(part)) return jsonResponse(status, body);
    }
    throw new Error(`Unexpected ${method} ${target}`);
  }) as unknown as typeof fetch;
}

async function bindAsOwner(): Promise<void> {
  await bindWorkspace(projectId, {
    remoteUrl,
    fetchImpl: fetchRouter([
      [
        'POST',
        '/v1/workspaces',
        201,
        {
          workspaceId: wsp,
          eventsUrl: `/v1/projects/${wsp}/events`,
          role: 'owner',
          inviteReachable: false,
        },
      ],
    ]),
  });
}

const roster = {
  workspaceId: wsp,
  name: 'Team',
  inviteReachable: true,
  members: [
    {
      accountId: 'acc_alice',
      role: 'owner',
      email: 'alice@example.com',
      joinedAt: '2026-07-01T00:00:00Z',
    },
    {
      accountId: 'acc_bob',
      role: 'member',
      email: 'bob@example.com',
      joinedAt: '2026-07-02T00:00:00Z',
    },
  ],
};

describe('refreshWorkspaceBinding (W-c role cache refresh)', () => {
  it('updates the cached role + reachability from the account workspace list', async () => {
    await bindAsOwner();
    const refreshed = await refreshWorkspaceBinding(projectId, {
      fetchImpl: fetchRouter([
        [
          'GET',
          '/v1/account/workspaces',
          200,
          {
            workspaces: [
              {
                workspaceId: wsp,
                eventsUrl: `/v1/projects/${wsp}/events`,
                role: 'member', // demoted elsewhere
                name: 'Team',
                inviteReachable: true, // invite minted elsewhere
                memberCount: 2,
              },
            ],
          },
        ],
      ]),
    });
    expect(refreshed).toEqual({
      workspaceId: wsp,
      role: 'member',
      inviteReachable: true,
    });
    // Persisted, not just returned.
    expect(await getWorkspaceBinding(projectId)).toEqual({
      workspaceId: wsp,
      role: 'member',
      inviteReachable: true,
    });
  });

  it('returns undefined and keeps the cache when the workspace no longer lists this account', async () => {
    await bindAsOwner();
    const refreshed = await refreshWorkspaceBinding(projectId, {
      fetchImpl: fetchRouter([
        ['GET', '/v1/account/workspaces', 200, { workspaces: [] }],
      ]),
    });
    expect(refreshed).toBeUndefined();
    // Stale cache stays as audit of what was last known.
    expect((await getWorkspaceBinding(projectId))?.role).toBe('owner');
  });

  it('is a no-op for a project that is not workspace-bound', async () => {
    expect(
      await refreshWorkspaceBinding('proj_unbound', {
        fetchImpl: fetchRouter([]),
      }),
    ).toBeUndefined();
  });
});

describe('listWorkspaceMembers / role management (W-c)', () => {
  it('reads the roster through the bind-persisted transport', async () => {
    await bindAsOwner();
    const result = await listWorkspaceMembers(projectId, {
      fetchImpl: fetchRouter([['GET', `/v1/workspaces/${wsp}`, 200, roster]]),
    });
    expect(result.members).toHaveLength(2);
    expect(result.members[1]!.email).toBe('bob@example.com');
  });

  it('promotes a member resolved by email', async () => {
    await bindAsOwner();
    const result = await changeWorkspaceMemberRole(projectId, 'Bob@Example.com', 'owner', {
      fetchImpl: fetchRouter([
        ['GET', `/v1/workspaces/${wsp}`, 200, roster],
        [
          'PATCH',
          `/v1/workspaces/${wsp}/members/acc_bob`,
          200,
          { accountId: 'acc_bob', role: 'owner' },
        ],
      ]),
    });
    expect(result).toEqual({ accountId: 'acc_bob', role: 'owner' });
  });

  it('removes a member resolved by accountId', async () => {
    await bindAsOwner();
    const result = await removeMemberFromWorkspace(projectId, 'acc_bob', {
      fetchImpl: fetchRouter([
        ['GET', `/v1/workspaces/${wsp}`, 200, roster],
        ['DELETE', `/v1/workspaces/${wsp}/members/acc_bob`, 204, {}],
      ]),
    });
    expect(result).toEqual({ accountId: 'acc_bob' });
  });

  it('fails loud when the member reference matches nobody', async () => {
    await bindAsOwner();
    await expect(
      changeWorkspaceMemberRole(projectId, 'nobody@example.com', 'member', {
        fetchImpl: fetchRouter([['GET', `/v1/workspaces/${wsp}`, 200, roster]]),
      }),
    ).rejects.toThrow(/No workspace member matches/);
  });

  it('surfaces Hub policy errors (member-not-owner 403) unchanged', async () => {
    await bindAsOwner();
    await expect(
      changeWorkspaceMemberRole(projectId, 'acc_bob', 'owner', {
        fetchImpl: fetchRouter([
          ['GET', `/v1/workspaces/${wsp}`, 200, roster],
          ['PATCH', `/v1/workspaces/${wsp}/members/acc_bob`, 403, { error: 'forbidden' }],
        ]),
      }),
    ).rejects.toThrow(/role change failed \(403/);
  });
});

describe('requireOwnerForGlobalRetract (W-c gate)', () => {
  it('passes for a live-verified owner', async () => {
    await bindAsOwner();
    await expect(
      requireOwnerForGlobalRetract(projectId, {
        fetchImpl: fetchRouter([
          [
            'GET',
            '/v1/account/workspaces',
            200,
            {
              workspaces: [
                { workspaceId: wsp, role: 'owner', inviteReachable: true },
              ],
            },
          ],
        ]),
      }),
    ).resolves.toBe('owner');
  });

  it('refuses when the live role is member — even with a stale owner cache', async () => {
    await bindAsOwner(); // cached role: owner
    await expect(
      requireOwnerForGlobalRetract(projectId, {
        fetchImpl: fetchRouter([
          [
            'GET',
            '/v1/account/workspaces',
            200,
            {
              workspaces: [
                { workspaceId: wsp, role: 'member', inviteReachable: true },
              ],
            },
          ],
        ]),
      }),
    ).rejects.toThrow(/Only a workspace owner/);
  });

  it('falls back to the cached role with a warning when the Hub is unreachable', async () => {
    await bindAsOwner();
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(
        requireOwnerForGlobalRetract(projectId, {
          fetchImpl: (async () => {
            throw new Error('ECONNREFUSED');
          }) as unknown as typeof fetch,
        }),
      ).resolves.toBe('owner');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('could not refresh workspace role'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses when membership was revoked (workspace absent from the account list)', async () => {
    await bindAsOwner();
    await expect(
      requireOwnerForGlobalRetract(projectId, {
        fetchImpl: fetchRouter([
          ['GET', '/v1/account/workspaces', 200, { workspaces: [] }],
        ]),
      }),
    ).rejects.toThrow(/no longer lists this account/);
  });

  it('refuses for a project that is not workspace-bound', async () => {
    await expect(
      requireOwnerForGlobalRetract('proj_unbound', {
        fetchImpl: fetchRouter([]),
      }),
    ).rejects.toThrow(/not workspace-bound/);
  });
});
