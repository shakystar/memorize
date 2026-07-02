import { describe, expect, it } from 'vitest';

import { renderPushResult } from '../../src/cli/sync-messages.js';

describe('renderPushResult - manual push output', () => {
  it('reports an empty push as healthy and shows the real watermark', () => {
    const message = renderPushResult(
      { accepted: [] },
      'evt_mr3r9yrn_jx48rtnl',
    );
    expect(message).toContain('Already up to date');
    expect(message).toContain('watermark=evt_mr3r9yrn_jx48rtnl');
    expect(message).not.toContain('Pushed 0 events');
  });

  it('shows watermark=none only when nothing was ever pushed', () => {
    expect(renderPushResult({ accepted: [] }, undefined)).toContain(
      'watermark=none',
    );
  });

  it('keeps the accepted-count wording for a non-empty push', () => {
    const message = renderPushResult(
      {
        accepted: ['evt_a', 'evt_b'],
        lastAcceptedEventId: 'evt_b',
      },
      'evt_b',
    );
    expect(message).toBe('Pushed 2 events. lastAcceptedEventId=evt_b');
  });

  it('falls back to none when a transport omits lastAcceptedEventId', () => {
    expect(
      renderPushResult({ accepted: ['evt_a'] }, undefined),
    ).toBe('Pushed 1 events. lastAcceptedEventId=none');
  });
});
