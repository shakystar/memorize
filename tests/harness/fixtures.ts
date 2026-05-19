/**
 * Documented hook payload factories. These mirror the JSON Claude Code
 * / Codex send on stdin to `memorize hook <agent> <event>`. Keep the
 * shapes minimal — the production parsers tolerate extra fields, and
 * tests that need them can use `payloadWithExtraFields`.
 */

export const claudeSessionStartPayload = (sessionId: string) => ({
  session_id: sessionId,
});

export const codexSessionStartPayload = (sessionId: string) => ({
  session_id: sessionId,
});

export const sessionEndPayload = (sessionId: string) => ({
  session_id: sessionId,
});

export const postCompactPayload = (compactSummary: string) => ({
  compact_summary: compactSummary,
});

export const emptyPayload = () => ({});

/**
 * The full documented Anthropic hook payload — includes fields memorize
 * does not consult (`transcript_path`, `cwd`, `hook_event_name`) to
 * verify parsers ignore them rather than reject.
 */
export const payloadWithExtraFields = (sessionId: string) => ({
  session_id: sessionId,
  transcript_path: '/tmp/claude-transcript.jsonl',
  cwd: '/tmp/some-project',
  hook_event_name: 'SessionStart',
});
