import path from 'node:path';

import type { AdapterAgent } from '../adapters/index.js';
import {
  type Observation,
  type ObservationSignal,
  createObservation,
} from '../domain/entities.js';
import { appendEvent } from '../storage/event-store.js';
import { getDb } from '../storage/db.js';
import { withFileLock } from '../storage/file-lock.js';
import { getProjectRoot } from '../storage/path-resolver.js';
import { rebuildProjectProjection } from './projection-store.js';
import {
  resolveByAgentSessionId,
  resolveSessionContext,
} from './session-context.js';

/**
 * A continuous conversation keyed by its transcript file, independent of how
 * many memorize session ids it spans. Compaction restarts the agent's
 * session_id mid-conversation (#109), and env/pid/tty resolution can miss the
 * owning session entirely (#108) — but the transcript path is stable across
 * both. We mirror the consolidator's `transcriptOffsetKey` convention
 * (basename, not the full path) so the same conversation maps to one key
 * everywhere. Used as a last-resort scope id so anonymous observations from
 * distinct conversations no longer collapse onto `projectId`.
 */
export function transcriptScopeId(transcriptPath: string): string {
  // Separator-agnostic basename: `path.basename` only splits on the running
  // platform's separator, so a Windows path on a POSIX runner (or a synced
  // event replayed on another OS) would keep its backslashes and never match.
  // Split on both to keep the key deterministic across platforms.
  const base = transcriptPath.split(/[/\\]/).pop() ?? transcriptPath;
  return `transcript:${base}`;
}

/**
 * CLS Phase 1 — short-term capture (the cheap half of D3).
 *
 * Runs on every PostToolUse hook fire. NO LLM, no transcript read, no FTS
 * reindex — just a rule-based decision-signal filter and, on a pass, one
 * event append. Everything expensive is deferred to the consolidation
 * boundary. The filter starts CONSERVATIVE (decision ③, 2026-06-08): missed
 * signals are acceptable because the boundary consolidator also reads the
 * transcript tail (D2 hybrid ownership) — noise in the raw layer is the
 * thing we cannot cheaply undo.
 */

/** Tools whose successful use is inherently a state-changing work signal.
 *  Spans harness vocabularies: Claude (Write/Edit/MultiEdit), Gemini CLI
 *  (`write_file`, and `replace` — Gemini's edit tool), Hermes (`write_file`
 *  for create, `patch` for edit), and Cursor (`Write`, shared with Claude).
 *  Recognizing a superset is harmless: a harness that never emits a given name
 *  simply never matches it. (Gemini and Hermes tool names confirmed via
 *  conformance dogfood; Cursor's are documented, not live-dogfooded — it has no
 *  headless CLI.) */
const WRITE_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'write_file',
  'replace',
  'patch',
]);

/**
 * Codex performs file edits through a single `apply_patch` tool rather than
 * Write/Edit/MultiEdit. Its hook input reports `tool_name: "apply_patch"` and
 * carries the raw patch body in `tool_input.command` (openai/codex#18391,
 * merged 2026-04-22, shipped in codex 0.137.0). Treating it as a write signal
 * is what makes codex sessions contribute file observations — without it,
 * codex's edits are invisible to cross-session sharing and collision
 * detection (Phase 1 only saw codex's Bash activity).
 */
const APPLY_PATCH_TOOLS = new Set(['apply_patch', 'ApplyPatch']);

/**
 * SINGLE SOURCE for the PostToolUse hook registration matcher. Derived from
 * the same whitelist evaluateCapture enforces, so install-service can never
 * drift from the filter: a tool added here both fires the hook AND passes
 * the filter; a tool absent here does neither. (Codex registers PostToolUse
 * with NO matcher — every fired tool reaches the filter — so apply_patch is
 * already delivered there; listing it here keeps Claude registration and the
 * filter in lockstep.)
 */
export const POST_TOOL_USE_MATCHER = [
  ...WRITE_TOOLS,
  ...APPLY_PATCH_TOOLS,
  'Bash',
].join('|');

/**
 * Extract the file paths an apply_patch envelope touches. The patch body uses
 * `*** Add File: <path>` / `*** Update File: <path>` / `*** Delete File:
 * <path>` headers (and `*** Move to: <path>` for renames). Returns every
 * referenced path in order; empty when the body is not a recognizable patch.
 */
export function extractApplyPatchPaths(patchBody: string): string[] {
  const paths: string[] = [];
  // "*** Add File: p" / "*** Update File: p" / "*** Delete File: p" plus the
  // rename target "*** Move to: p" (which has no "File" keyword).
  const pattern = /^\*\*\*\s+(?:(?:Add|Update|Delete)\s+File|Move to):\s*(.+?)\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(patchBody)) !== null) {
    paths.push(match[1]!);
  }
  return paths;
}

/**
 * Mutating Bash command patterns (tuning parameter — seed list from the
 * 2026-06-08 decision; adjust against real transcripts). Read-only commands
 * (ls / cat / git status / grep …) intentionally do NOT match.
 */
const MUTATING_BASH_PATTERN = new RegExp(
  [
    String.raw`\bgit\s+(commit|push|merge|rebase|reset|revert|cherry-pick|tag|stash)\b`,
    String.raw`\b(npm|pnpm|yarn)\s+(install|add|remove|uninstall|publish|link)\b`,
    String.raw`\bpip3?\s+install\b`,
    String.raw`\b(rm|rmdir|del|mv|move|ren)\s`,
  ].join('|'),
);

/**
 * Destructive operations on the SHARED git state (the common `.git` dir or the
 * `.worktrees/` set). Concurrent sessions running any two of these race and can
 * corrupt the shared repo (2026-06-22 incident). Used both to ADMIT these as
 * mutating-bash observations and, in realtime-share, to DETECT cross-session
 * collisions — one source of truth so the two never drift. Read-only forms
 * (`git worktree list`, `git branch`, `rm -rf build`) intentionally do not match.
 */
export const DESTRUCTIVE_GIT_PATTERN = new RegExp(
  [
    String.raw`\bgit\s+worktree\s+(remove|prune)\b`,
    String.raw`\bgit\s+branch\s+(-d\b|-D\b|--delete\b)`,
    String.raw`\b(rm|rmdir)\s+[^\n]*(\.git\b|\.worktrees\b)`,
  ].join('|'),
);

/** `memorize task …` invocations that mark a task state transition. */
const TASK_TRANSITION_PATTERN =
  /\bmemorize\s+task\s+(update|handoff|checkpoint|claim|complete|create)\b/;

/**
 * Decision-keyword heuristic (tuning parameter — seed list). Matched against
 * the Bash command text only; write-tool inputs are file contents where
 * these words are far too common to be a signal.
 */
const DECISION_KEYWORD_PATTERN =
  /결정|선택|포기|대신|하기로|방향|\bdecided?\b|\bdecision\b|\bchose\b|\binstead of\b|\babandon\b/i;

const MAX_SUMMARY_LENGTH = 240;

export interface CaptureVerdict {
  capture: boolean;
  signal?: ObservationSignal;
  /** Cheap rule-derived one-liner for the observation row. */
  summary?: string;
  /** Structured file path for write signals (Phase 2 collision detection).
   *  For apply_patch (multi-file) this is the FIRST touched path; the full
   *  list is in `summary`. */
  filePath?: string;
}

function clip(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_SUMMARY_LENGTH
    ? `${collapsed.slice(0, MAX_SUMMARY_LENGTH - 1)}…`
    : collapsed;
}

/**
 * The decision-signal filter (rule-based, LLM-free). Exported for unit
 * tests — captureObservation is the only production caller.
 */
export function evaluateCapture(
  toolName: string | undefined,
  toolInputText: string,
): CaptureVerdict {
  if (!toolName) return { capture: false };

  if (WRITE_TOOLS.has(toolName)) {
    return {
      capture: true,
      signal: 'write-tool',
      summary: clip(`${toolName}: ${toolInputText}`),
      ...(toolInputText ? { filePath: toolInputText } : {}),
    };
  }

  // Codex edits via apply_patch (tool_input.command = raw patch body). Extract
  // the touched paths so the observation carries a structured filePath for
  // collision detection, exactly like a Write/Edit.
  if (APPLY_PATCH_TOOLS.has(toolName)) {
    const paths = extractApplyPatchPaths(toolInputText);
    return {
      capture: true,
      signal: 'write-tool',
      summary: clip(
        paths.length > 0 ? `apply_patch: ${paths.join(', ')}` : `apply_patch: ${toolInputText}`,
      ),
      ...(paths[0] ? { filePath: paths[0] } : {}),
    };
  }

  // Shell-tool branch across harnesses: Claude `Bash`, Codex `shell`, Gemini
  // CLI `run_shell_command`, Hermes `terminal`, Cursor `Shell`.
  if (
    toolName === 'Bash' ||
    toolName === 'shell' ||
    toolName === 'run_shell_command' ||
    toolName === 'terminal' ||
    toolName === 'Shell'
  ) {
    if (TASK_TRANSITION_PATTERN.test(toolInputText)) {
      return {
        capture: true,
        signal: 'task-transition',
        summary: clip(toolInputText),
      };
    }
    if (
      MUTATING_BASH_PATTERN.test(toolInputText) ||
      DESTRUCTIVE_GIT_PATTERN.test(toolInputText)
    ) {
      return {
        capture: true,
        signal: 'mutating-bash',
        summary: clip(toolInputText),
      };
    }
    if (DECISION_KEYWORD_PATTERN.test(toolInputText)) {
      return {
        capture: true,
        signal: 'decision-keyword',
        summary: clip(toolInputText),
      };
    }
  }

  return { capture: false };
}

export interface PostToolUsePayloadFields {
  toolName?: string;
  toolInputText: string;
  transcriptPath?: string;
  agentSessionId?: string;
  conversationId?: string;
  generationId?: string;
  toolUseId?: string;
}

/**
 * Defensive parse of a PostToolUse hook stdin payload (Claude and codex
 * share the field names; codex's transcript format is explicitly "not a
 * stable interface", so nothing here assumes more than string-typed
 * top-level fields).
 */
export function parsePostToolUsePayload(
  raw: string | undefined,
): PostToolUsePayloadFields {
  let parsed: unknown;
  try {
    // Cursor pipes hook payloads as UTF-8 WITH a BOM; JSON.parse rejects a
    // leading U+FEFF, which would silently drop every capture. Strip it.
    parsed = raw ? JSON.parse(raw.replace(/^\uFEFF/, '')) : {};
  } catch {
    return { toolInputText: '' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { toolInputText: '' };
  }
  const obj = parsed as Record<string, unknown>;
  const toolName =
    typeof obj.tool_name === 'string' ? obj.tool_name : undefined;
  const transcriptPath =
    typeof obj.transcript_path === 'string' ? obj.transcript_path : undefined;
  // The agent's own session id (Claude/codex UUID). We stamp this same id as
  // `agentSessionId` on the cwd pointer at SessionStart, so it lets us recover
  // the owning memorize session when env/pid/tty resolution misses (#108).
  const agentSessionId =
    typeof obj.session_id === 'string' ? obj.session_id : undefined;
  const conversationId =
    typeof obj.conversation_id === 'string' ? obj.conversation_id : undefined;
  const generationId =
    typeof obj.generation_id === 'string' ? obj.generation_id : undefined;
  const toolUseId =
    typeof obj.tool_use_id === 'string' ? obj.tool_use_id : undefined;

  // Flatten tool_input into a single searchable text. For Write/Edit the
  // interesting field is file_path; for Bash it is command. Fall back to a
  // JSON stringification capped well below hook content limits.
  let toolInputText = '';
  const toolInput = obj.tool_input;
  if (toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)) {
    const input = toolInput as Record<string, unknown>;
    if (typeof input.command === 'string') {
      toolInputText = input.command;
    } else if (typeof input.file_path === 'string') {
      toolInputText = input.file_path;
    } else {
      try {
        toolInputText = JSON.stringify(input).slice(0, 2000);
      } catch {
        toolInputText = '';
      }
    }
  } else if (typeof toolInput === 'string') {
    toolInputText = toolInput;
  }

  return {
    ...(toolName ? { toolName } : {}),
    toolInputText,
    ...(transcriptPath ? { transcriptPath } : {}),
    ...(agentSessionId ? { agentSessionId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(generationId ? { generationId } : {}),
    ...(toolUseId ? { toolUseId } : {}),
  };
}

function hasCapturedToolUse(
  projectId: string,
  agentSessionId: string,
  toolUseId: string,
): boolean {
  const row = getDb(projectId)
    .prepare(
      `SELECT 1
         FROM events
        WHERE type = 'observation.captured'
          AND json_extract(payload, '$.agentSessionId') = ?
          AND json_extract(payload, '$.toolUseId') = ?
        LIMIT 1`,
    )
    .get(agentSessionId, toolUseId);
  return Boolean(row);
}

/**
 * PostToolUse entry point: filter → (on pass) append `observation.captured`
 * → rebuild projection WITHOUT reindexing FTS (decision ④ — observations
 * are not searchable entities; the expensive index work happens once at the
 * consolidation boundary, same pattern as session heartbeats).
 *
 * Returns the captured observation, or undefined when the filter rejected
 * the event (read-only tool, chatter).
 */
export async function captureObservation(params: {
  projectId: string;
  agent: AdapterAgent;
  cwd: string;
  rawPayload: string | undefined;
}): Promise<Observation | undefined> {
  const payload = parsePostToolUsePayload(params.rawPayload);
  const verdict = evaluateCapture(payload.toolName, payload.toolInputText);
  if (!verdict.capture || !verdict.signal) return undefined;
  const signal = verdict.signal;

  const sessionCtx = await resolveSessionContext(params.cwd, {
    debugLabel: 'hook-post-tool-use',
  });

  // #108: env/pid/tty resolution can miss the owning session (notably on
  // Windows, where the PostToolUse hook process is neither a pid-descendant of
  // the agent nor tty-attached). Before falling back to an anonymous scope,
  // recover the session from the agent's own session_id in the payload —
  // matched against the `agentSessionId` we stamped on the cwd pointer at
  // SessionStart. Without this, ~6% of observations here were captured with no
  // session and collapsed onto `projectId` as a shared scope.
  let sessionId = sessionCtx.sessionId;
  if (!sessionId && payload.agentSessionId) {
    const recovered = await resolveByAgentSessionId(
      params.cwd,
      payload.agentSessionId,
      { debugLabel: 'hook-post-tool-use-agent-id' },
    );
    sessionId = recovered.sessionId;
  }

  // The structured file path (set by evaluateCapture for Write/Edit/MultiEdit
  // and apply_patch) lets Phase 2 live sharing detect cross-session file
  // collisions without re-parsing the clipped summary. Bash signals carry a
  // command, not a path — left unset there.
  const appendCapturedObservation = async (): Promise<Observation | undefined> => {
    if (
      params.agent === 'cursor' &&
      payload.agentSessionId &&
      payload.toolUseId &&
      hasCapturedToolUse(params.projectId, payload.agentSessionId, payload.toolUseId)
    ) {
      return undefined;
    }

    const observation = createObservation({
      projectId: params.projectId,
      signal,
      ...(sessionId ? { sessionId } : {}),
      ...(payload.toolName ? { toolName: payload.toolName } : {}),
      ...(verdict.summary ? { summary: verdict.summary } : {}),
      ...(verdict.filePath ? { filePath: verdict.filePath } : {}),
      ...(payload.transcriptPath
        ? { transcriptPath: payload.transcriptPath }
        : {}),
      ...(payload.agentSessionId ? { agentSessionId: payload.agentSessionId } : {}),
      ...(payload.conversationId ? { conversationId: payload.conversationId } : {}),
      ...(payload.generationId ? { generationId: payload.generationId } : {}),
      ...(payload.toolUseId ? { toolUseId: payload.toolUseId } : {}),
    });

  // Scope fallback ladder: real session → stable per-conversation key
  // (transcript) → project. The transcript step stops distinct conversations
  // from collapsing onto one `projectId` scope when the session is unknown
  // (#108), while staying constant across compaction's session splits (#109).
    const scopeId =
      sessionId ??
      (payload.transcriptPath
        ? transcriptScopeId(payload.transcriptPath)
        : params.projectId);

    await appendEvent({
      type: 'observation.captured',
      projectId: params.projectId,
      scopeType: 'session',
      scopeId,
      actor: params.agent,
      payload: observation,
    });
    await rebuildProjectProjection(params.projectId, { reindexSearch: false });
    return observation;
  };

  if (params.agent === 'cursor' && payload.agentSessionId && payload.toolUseId) {
    return withFileLock(
      path.join(getProjectRoot(params.projectId), 'locks'),
      'cursor-post-tool-use',
      appendCapturedObservation,
    );
  }

  return appendCapturedObservation();
}
