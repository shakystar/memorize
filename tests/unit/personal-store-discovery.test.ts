import { describe, expect, it } from 'vitest';

import { resolvePersonalStore } from '../../src/adapters/sync-transport-http.js';

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

describe('resolvePersonalStore (GET /v1/account/personal-store)', () => {
  it('returns the server-minted psm_ store id', async () => {
    const result = await resolvePersonalStore('https://hub.test/', 'tok', {
      fetchImpl: fakeFetch({
        ok: true,
        status: 200,
        json: {
          storeId: 'psm_3gseJo7gpo7Q',
          eventsUrl: '/v1/projects/psm_3gseJo7gpo7Q/events',
        },
      }),
    });
    // Note the uppercase in the id — a Hub-namespace id, never validated against
    // the client's lowercase ID_PATTERN.
    expect(result.storeId).toBe('psm_3gseJo7gpo7Q');
    expect(result.eventsUrl).toContain('psm_3gseJo7gpo7Q');
  });

  it('throws with the status on a non-2xx (e.g. a scoped key → 403)', async () => {
    await expect(
      resolvePersonalStore('https://hub.test', 'tok', {
        fetchImpl: fakeFetch({
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          text: '{"error":"scoped key cannot reach personal memory"}',
        }),
      }),
    ).rejects.toThrow(/403/);
  });
});
