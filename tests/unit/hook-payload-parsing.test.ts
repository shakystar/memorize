import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  parseIdentityPayload,
  parsePostCompactPayload,
} from '../../src/services/hook-service.js';

// `parseJsonObject` writes warnings to process.stderr on bad input.
// Silence those so test output stays clean — we still assert behavior
// via the return value.
let stderrSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  stderrSpy.mockRestore();
});

describe('parseIdentityPayload', () => {
  it('extracts session_id from a documented SessionStart payload', () => {
    const raw = JSON.stringify({ session_id: 'abc' });
    expect(parseIdentityPayload(raw)).toEqual({ agentSessionId: 'abc' });
  });

  it('returns empty object when session_id is missing', () => {
    const raw = JSON.stringify({});
    expect(parseIdentityPayload(raw)).toEqual({});
  });

  it('returns empty object when session_id is the wrong type', () => {
    const raw = JSON.stringify({ session_id: 42 });
    expect(parseIdentityPayload(raw)).toEqual({});
  });

  it('returns empty object on a JSON null payload', () => {
    expect(parseIdentityPayload('null')).toEqual({});
  });

  it('ignores extra fields documented by Anthropic hook schema', () => {
    const raw = JSON.stringify({
      session_id: 'abc',
      transcript_path: '/tmp/x',
      cwd: '/tmp/y',
      hook_event_name: 'SessionStart',
    });
    expect(parseIdentityPayload(raw)).toEqual({ agentSessionId: 'abc' });
  });

  it('returns empty object when raw is undefined', () => {
    expect(parseIdentityPayload(undefined)).toEqual({});
  });

  it('returns empty object when raw is not valid JSON', () => {
    expect(parseIdentityPayload('not-json')).toEqual({});
  });
});

describe('parsePostCompactPayload', () => {
  it('extracts compact_summary from a documented PostCompact payload', () => {
    const raw = JSON.stringify({ compact_summary: 'foo' });
    expect(parsePostCompactPayload(raw)).toEqual({ compactSummary: 'foo' });
  });

  it('returns empty object when compact_summary is missing', () => {
    const raw = JSON.stringify({});
    expect(parsePostCompactPayload(raw)).toEqual({});
  });

  it('returns empty object when compact_summary is the wrong type', () => {
    const raw = JSON.stringify({ compact_summary: 42 });
    expect(parsePostCompactPayload(raw)).toEqual({});
  });

  it('returns empty object on a JSON null payload', () => {
    expect(parsePostCompactPayload('null')).toEqual({});
  });

  it('returns empty object when raw is undefined', () => {
    expect(parsePostCompactPayload(undefined)).toEqual({});
  });
});
