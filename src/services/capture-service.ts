import type { AdapterAgent } from '../adapters/index.js';
import {
  type Observation,
  type ObservationSignal,
  createObservation,
} from '../domain/entities.js';
import { appendEvent } from '../storage/event-store.js';
import { rebuildProjectProjection } from './projection-store.js';
import { resolveSessionContext } from './session-context.js';

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

/** Tools whose successful use is inherently a state-changing work signal. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

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

  // Codex also fires PostToolUse for Bash-like shell tools.
  if (toolName === 'Bash' || toolName === 'shell') {
    if (TASK_TRANSITION_PATTERN.test(toolInputText)) {
      return {
        capture: true,
        signal: 'task-transition',
        summary: clip(toolInputText),
      };
    }
    if (MUTATING_BASH_PATTERN.test(toolInputText)) {
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
    parsed = raw ? JSON.parse(raw) : {};
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
  };
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

  const sessionCtx = await resolveSessionContext(params.cwd, {
    debugLabel: 'hook-post-tool-use',
  });

  // The structured file path (set by evaluateCapture for Write/Edit/MultiEdit
  // and apply_patch) lets Phase 2 live sharing detect cross-session file
  // collisions without re-parsing the clipped summary. Bash signals carry a
  // command, not a path — left unset there.
  const observation = createObservation({
    projectId: params.projectId,
    signal: verdict.signal,
    ...(sessionCtx.sessionId ? { sessionId: sessionCtx.sessionId } : {}),
    ...(payload.toolName ? { toolName: payload.toolName } : {}),
    ...(verdict.summary ? { summary: verdict.summary } : {}),
    ...(verdict.filePath ? { filePath: verdict.filePath } : {}),
    ...(payload.transcriptPath
      ? { transcriptPath: payload.transcriptPath }
      : {}),
  });

  await appendEvent({
    type: 'observation.captured',
    projectId: params.projectId,
    scopeType: 'session',
    scopeId: sessionCtx.sessionId ?? params.projectId,
    actor: params.agent,
    payload: observation,
  });
  await rebuildProjectProjection(params.projectId, { reindexSearch: false });
  return observation;
}
