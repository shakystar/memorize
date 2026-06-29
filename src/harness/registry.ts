/**
 * Harness registry — the single source of truth for which agent harnesses
 * memorize integrates with and how each one diverges.
 *
 * Historically the supported pair (Claude Code, Codex) was hardcoded across
 * three separate union types (`AgentName`, `AdapterAgent`, `HostCliCommand`),
 * per-agent properties on the detection result, and per-agent hook-handler
 * maps. Adding a harness meant hand-editing every one of those in lockstep.
 *
 * This module centralizes harness identity into one `HarnessId` union and a
 * list of capability descriptors. Detection, the adapter registry, hook
 * dispatch, install/uninstall, doctor, and the consolidation extractor all
 * derive from `harnessRegistry` instead of naming `.claude`/`.codex`.
 *
 * Keep this a DEPENDENCY-LIGHT LEAF: it must not import from `../services` or
 * `../adapters` (those import from here). Renderers and runtime handlers stay
 * in their own modules and are wired to descriptors by id.
 */

export type HarnessId =
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'gemini'
  | 'pi'
  | 'hermes'
  | 'cursor';

export interface HarnessDescriptor {
  /** Stable id; also the `memorize hook <id> <event>` token and (for
   *  claude/codex) the launcher binary name probed on PATH. */
  id: HarnessId;
  /** Human label for summaries/notices. */
  label: string;
  /** Config dir relative to the home directory — the "this harness has run"
   *  detection signal. NOT always `.${id}`: opencode uses `.config/opencode`,
   *  not `.opencode`. */
  configDirRel: string;
  /** Lifecycle hook events memorize registers at install time, in this
   *  harness's NATIVE event names (Claude/Codex use the canonical names;
   *  Gemini uses `AfterTool`/`PreCompress`/…). */
  hookEvents: readonly string[];
  /**
   * Maps a harness's NATIVE hook event name → the canonical runtime handler
   * key (SessionStart / PostToolUse / PostCompact / SessionEnd). Lets one set
   * of handlers serve harnesses that name the same lifecycle moment
   * differently — e.g. Gemini `AfterTool` → `PostToolUse`. Omitted ⇒ identity
   * (Claude/Codex already use the canonical names).
   */
  eventHandlerMap?: Readonly<Record<string, string>>;
  /** Events a prior install may have registered that the current contract
   *  no longer wants — stripped on re-install. */
  legacyHookEvents: readonly string[];
  /** Events whose runtime handler is kept as a no-op so pre-upgrade installs
   *  that still fire them don't error (currently just `Stop`). */
  legacyHandledEvents: readonly string[];
  /**
   * Config-mechanism FAMILY — how the harness loads memorize's hooks. Harnesses
   * cluster into families, not one uniform writer:
   *   - 'json-hooks-map': a JSON settings file mapping event → command entries
   *     (Claude `.claude/settings.local.json`, Codex `~/.codex/hooks.json`;
   *     later Gemini/Cursor/Copilot).
   *   - 'ts-plugin': a TypeScript plugin module that subscribes to lifecycle
   *     events and shells out (opencode `.opencode/plugins/*.ts`; pi).
   *   - 'yaml-shell-hooks': a YAML config (`~/.hermes/config.yaml`) mapping
   *     event → shell command(s) that Hermes runs as subprocesses, piping a
   *     JSON payload on stdin and reading stdout JSON back. memorize's `hook`
   *     command natively speaks that stdin/stdout contract; the only divergence
   *     is the wire envelope (see `runHook`'s hermes translation).
   * The install writer dispatches on this.
   */
  mechanism: 'json-hooks-map' | 'ts-plugin' | 'yaml-shell-hooks';
  /** Whether install should register the memorize MCP server in this harness's
   *  config. Used where MCP fills a gap the hook mechanism can't (e.g. opencode
   *  has no session-start-injection hook, so session-start context arrives via
   *  the MCP `memorize_context` tool / `session-context` prompt). */
  registersMcp: boolean;
  /** Where the harness reads its hooks: per-project config vs machine-global. */
  hookScope: 'project' | 'global';
  /** New memorize entries appended after the user's hooks (claude) or
   *  prepended before them so our context is established first (codex).
   *  Only meaningful for the 'json-hooks-map' mechanism. */
  hookPlacement: 'append' | 'prepend';
  /** The standing-instruction file the ground-rule block is planted in. */
  groundRuleFile: string;
  /** Whether install plants the per-project `using-memorize` Agent Skill. */
  plantsSkill: boolean;
  /** Hook runner auto-creates a project binding (claude) vs bails when the
   *  cwd is unbound (codex — its hooks are global, so it fires everywhere). */
  autoBindProject: boolean;
  /**
   * The harness has no once-per-session injection event, so its SessionStart
   * handler is wired to a per-TURN event (hermes `pre_llm_call`, the only
   * stdout channel Hermes injects from). `runHook` then gates injection to the
   * FIRST turn of each agent session — keyed by the payload's `session_id`,
   * matched to the agentSessionId stamped at mint — so memory is injected once
   * (the conversation carries it thereafter), not re-injected every turn.
   * Harnesses with a real once-per-session SessionStart leave this false/unset.
   */
  sessionStartPerTurn?: boolean;
  /**
   * How this harness wants memorize's injected context wired on stdout. The
   * shared handlers always emit Claude's `hookSpecificOutput.additionalContext`;
   * `renderHookWire` translates that to the harness's native field when it
   * differs:
   *   - undefined ⇒ Claude's shape, consumed directly (Claude/Codex/Gemini; the
   *     ts-plugin harnesses opencode/pi translate harness-side in the planted
   *     extension, so they also leave this unset).
   *   - 'context'            ⇒ hermes `{"context": "..."}` (its pre_llm_call
   *     injection channel; every other hook's stdout is ignored).
   *   - 'additional_context' ⇒ cursor `{"additional_context": "..."}` — the
   *     field cursor reads from sessionStart (initial system context) and
   *     postToolUse (injected after the tool result). snake_case + top-level,
   *     NOT nested under hookSpecificOutput.
   */
  injectionWire?: 'context' | 'additional_context';
}

// --- Claude Code -------------------------------------------------------------

// Stop is intentionally absent from the registered set — it fires per-turn,
// not per-session; lifecycle moved to SessionEnd + reapStaleSessions.
// PreCompact is gone (#85): replaced wholesale by the PostCompact boundary.
// PostToolUse (CLS capture) carries a tool matcher (see install-service) so the
// subprocess only spawns for tools the decision-signal filter could admit.
const CLAUDE: HarnessDescriptor = {
  id: 'claude',
  label: 'Claude Code',
  configDirRel: '.claude',
  hookEvents: ['SessionStart', 'PostCompact', 'SessionEnd', 'PostToolUse'],
  legacyHookEvents: ['Stop', 'PreCompact'],
  legacyHandledEvents: ['Stop'],
  mechanism: 'json-hooks-map',
  registersMcp: false,
  hookScope: 'project',
  hookPlacement: 'append',
  groundRuleFile: 'CLAUDE.md',
  plantsSkill: true,
  autoBindProject: true,
};

// --- Codex -------------------------------------------------------------------

// Codex has no SessionEnd / Shutdown hook (verified against
// developers.openai.com/codex/hooks 2026-05), so its session lifecycle is owned
// by reapStaleSessions and the CLS boundary is PostCompact + the next
// SessionStart's catch-up. PostToolUse fires for Bash-like tools only today —
// partial capture beats none, and coverage widens if the upstream issue lands.
const CODEX: HarnessDescriptor = {
  id: 'codex',
  label: 'Codex',
  configDirRel: '.codex',
  hookEvents: ['SessionStart', 'PostToolUse', 'PostCompact'],
  legacyHookEvents: ['Stop'],
  legacyHandledEvents: ['Stop'],
  mechanism: 'json-hooks-map',
  registersMcp: false,
  hookScope: 'global',
  hookPlacement: 'prepend',
  groundRuleFile: 'AGENTS.md',
  plantsSkill: false,
  autoBindProject: false,
};

// --- opencode ----------------------------------------------------------------

// opencode integrates via a TypeScript PLUGIN (`.opencode/plugins/*.ts`), not a
// JSON hooks map. Its plugin API has `tool.execute.after` (→ PostToolUse
// capture) and `experimental.session.compacting` (→ PostCompact boundary +
// context push) but NO session-start-injection hook — so session-start memory
// is delivered through the MCP pillar (registersMcp), not a hook. SessionStart
// is therefore absent from hookEvents. The plugin is planted globally
// (~/.config/opencode/plugins/), so like codex it bails when cwd is unbound.
const OPENCODE: HarnessDescriptor = {
  id: 'opencode',
  label: 'opencode',
  // opencode's config lives under ~/.config/opencode, NOT ~/.opencode.
  configDirRel: '.config/opencode',
  hookEvents: ['PostToolUse', 'PostCompact'],
  legacyHookEvents: [],
  legacyHandledEvents: ['Stop'],
  mechanism: 'ts-plugin',
  registersMcp: true,
  hookScope: 'global',
  hookPlacement: 'append',
  groundRuleFile: 'AGENTS.md',
  plantsSkill: false,
  autoBindProject: false,
};

// --- Gemini CLI --------------------------------------------------------------

// Gemini CLI's hooks live in settings.json with a schema IDENTICAL to Claude's
// (matcher groups + {type,command}), and SessionStart injects context via the
// SAME `hookSpecificOutput.additionalContext` field — so the shared handlers
// work as-is and gemini gets full session-start injection. It only DIFFERS in
// event NAMES: `AfterTool` (not PostToolUse), `PreCompress` (not PostCompact) —
// translated by eventHandlerMap. Tool names also differ (write_file/replace/
// run_shell_command); the capture filter learns those via conformance dogfood.
const GEMINI: HarnessDescriptor = {
  id: 'gemini',
  label: 'Gemini CLI',
  configDirRel: '.gemini',
  // NATIVE gemini event names; eventHandlerMap routes them to canonical handlers.
  hookEvents: ['SessionStart', 'AfterTool'],
  legacyHookEvents: [],
  legacyHandledEvents: [],
  eventHandlerMap: { AfterTool: 'PostToolUse' },
  mechanism: 'json-hooks-map',
  registersMcp: false,
  hookScope: 'global',
  hookPlacement: 'append',
  groundRuleFile: 'GEMINI.md',
  plantsSkill: false,
  autoBindProject: false,
};

// --- pi ----------------------------------------------------------------------

// pi (earendil-works/pi) integrates via a TypeScript EXTENSION
// (`~/.pi/agent/extensions/*.ts`), the same ts-plugin family as opencode — but
// pi's hook surface is the FULLEST of any harness so far. Its `before_agent_start`
// event can inject a message into the model (`return { message: {...} }`), so
// UNLIKE opencode, pi gets real session-start memory injection THROUGH the hook
// (the extension gates it to fire once per session). `tool_result` → PostToolUse
// capture; `session_compact` → PostCompact boundary. hookEvents are the CANONICAL
// names (the extension maps pi's native event names internally before shelling
// to `memorize hook pi <event>`), so no eventHandlerMap is needed.
//
// pi has NO first-party MCP; a community extension reads ~/.pi/agent/mcp.json
// (Claude-format). registersMcp merges memorize's block there so an MCP-capable
// pi setup picks it up — but session-start memory does NOT depend on it (the
// before_agent_start hook delivers that), so MCP here is additive, not load-bearing.
//
// pi reads AGENTS.md/CLAUDE.md natively (global + walking up from cwd), so the
// ground-rule lands in AGENTS.md with no extra config wiring (unlike opencode's
// `instructions` array). The extension is planted globally (~/.pi/agent/extensions/),
// so like codex/opencode it bails when the cwd is unbound.
const PI: HarnessDescriptor = {
  id: 'pi',
  label: 'pi',
  configDirRel: '.pi',
  hookEvents: ['SessionStart', 'PostToolUse', 'PostCompact'],
  legacyHookEvents: [],
  legacyHandledEvents: ['Stop'],
  mechanism: 'ts-plugin',
  registersMcp: true,
  hookScope: 'global',
  hookPlacement: 'append',
  groundRuleFile: 'AGENTS.md',
  plantsSkill: false,
  autoBindProject: false,
};

// --- Hermes ------------------------------------------------------------------

// Hermes (NousResearch/hermes-agent) is the first 'yaml-shell-hooks' harness:
// its hooks live in `~/.hermes/config.yaml` as event → shell command(s) that
// Hermes runs as subprocesses, piping a JSON payload on stdin and reading
// stdout JSON. memorize's `hook` command natively speaks that contract, so the
// command is just `memorize hook hermes <native-event>` (no planted plugin).
//
// Event mapping (eventHandlerMap, native → canonical):
//   - `pre_llm_call` → SessionStart. This is the ONLY stdout channel Hermes
//     injects from (`{"context": "..."}`), but it fires EVERY turn — so this is
//     the harness that needs `sessionStartPerTurn` gating (inject on turn 1
//     only). The handler's `additionalContext` is translated to `{context}` by
//     runHook's hermes wire renderer.
//   - `post_tool_call` → PostToolUse capture (Hermes IGNORES its stdout — "all
//     other hooks are fire-and-forget observers" — so no live-update injection
//     here; capture still runs).
//   - `on_session_finalize` → PostCompact boundary (fires on /new, idle GC, or
//     CLI quit — the moment the session's context is torn down).
//
// Hermes reads AGENTS.md natively into the system prompt (alongside CLAUDE.md /
// .cursorrules / SOUL.md / .hermes.md), so the ground rule lands in AGENTS.md
// with no extra wiring. It ALSO supports MCP natively (`mcp_servers` in the SAME
// config.yaml), so registersMcp merges memorize there too — additive, since
// session-start memory is delivered by the pre_llm_call hook, not MCP. Hooks are
// global (config.yaml is user-level), so like codex it bails when cwd is unbound.
const HERMES: HarnessDescriptor = {
  id: 'hermes',
  label: 'Hermes',
  configDirRel: '.hermes',
  // NATIVE hermes event names; eventHandlerMap routes them to canonical handlers.
  hookEvents: ['pre_llm_call', 'post_tool_call', 'on_session_finalize'],
  legacyHookEvents: [],
  legacyHandledEvents: ['Stop'],
  eventHandlerMap: {
    pre_llm_call: 'SessionStart',
    post_tool_call: 'PostToolUse',
    on_session_finalize: 'PostCompact',
  },
  mechanism: 'yaml-shell-hooks',
  registersMcp: true,
  hookScope: 'global',
  hookPlacement: 'append',
  groundRuleFile: 'AGENTS.md',
  plantsSkill: false,
  autoBindProject: false,
  sessionStartPerTurn: true,
  injectionWire: 'context',
};

// --- Cursor ------------------------------------------------------------------

// Cursor integrates via the 'json-hooks-map' family, but its on-disk shape and
// injection wire DIVERGE from Claude/Codex/Gemini — so it gets a dedicated
// writer (writeCursorHooks) rather than the shared writeHooksMap:
//   - hooks file: `.cursor/hooks.json`, shape `{ "version": 1, "hooks": {
//     "<event>": [{ "command", "matcher?", "timeout?" }] } }`. FLAT entries —
//     NO Claude-style `{ matcher, hooks: [{type,command}] }` group nesting.
//   - Cursor's hooks are PER-PROJECT (run from the project root, like Claude's
//     `.claude/`), so hookScope is 'project' and autoBindProject is true — a
//     project-scoped hook only fires inside its own repo, so auto-binding on
//     SessionStart is safe (unlike the global harnesses, which must bail when
//     the cwd is unbound because their hooks fire everywhere).
//
// Cursor's hook surface is the FULLEST of any harness: all four canonical
// lifecycle boundaries map to NATIVE cursor events (eventHandlerMap):
//   - `sessionStart`  → SessionStart. INJECTS memory: cursor reads stdout
//     `{"additional_context": "..."}` into the conversation's initial system
//     context, so cursor gets real session-start injection THROUGH the hook
//     (like gemini/pi, unlike opencode). injectionWire 'additional_context'
//     translates the canonical Claude shape to that field.
//   - `postToolUse`   → PostToolUse capture (+ live-update via the same
//     `additional_context` field, injected after the tool result). Registered
//     with NO matcher — every successful tool reaches the in-handler filter
//     (cursor tool names: Shell/Read/Write/MCP/Task; see capture-service).
//   - `preCompact`    → PostCompact boundary. Cursor fires this BEFORE
//     compaction (its payload carries context_usage, not a compact_summary —
//     the handler degrades to "summary unavailable"); the consolidation side
//     effect is the point, not the cosmetic return.
//   - `sessionEnd`    → SessionEnd (pause + final consolidate), like Claude.
//
// Cursor reads AGENTS.md / CLAUDE.md natively as rules, so the ground rule lands
// in AGENTS.md with no extra wiring (reuses upsertGroundRuleBlock). MCP is
// registered into `.cursor/mcp.json` (top-level `mcpServers`, Claude format) —
// additive, since session-start memory is delivered by the sessionStart hook,
// not MCP. Cursor is an IDE with no headless CLI, so Docker conformance can
// assert install ARTIFACTS only; live capture/injection dogfood is structurally
// impossible (documented as a gap, not a passing test).
const CURSOR: HarnessDescriptor = {
  id: 'cursor',
  label: 'Cursor',
  configDirRel: '.cursor',
  // NATIVE cursor event names; eventHandlerMap routes them to canonical handlers.
  hookEvents: ['sessionStart', 'postToolUse', 'preCompact', 'sessionEnd'],
  legacyHookEvents: [],
  legacyHandledEvents: ['Stop'],
  eventHandlerMap: {
    sessionStart: 'SessionStart',
    postToolUse: 'PostToolUse',
    preCompact: 'PostCompact',
    sessionEnd: 'SessionEnd',
  },
  mechanism: 'json-hooks-map',
  registersMcp: true,
  hookScope: 'project',
  hookPlacement: 'append',
  groundRuleFile: 'AGENTS.md',
  plantsSkill: false,
  autoBindProject: true,
  injectionWire: 'additional_context',
};

/** All supported harnesses, in display order. */
export const harnessRegistry: readonly HarnessDescriptor[] = [
  CLAUDE,
  CODEX,
  OPENCODE,
  GEMINI,
  PI,
  HERMES,
  CURSOR,
];

const byId: Record<HarnessId, HarnessDescriptor> = {
  claude: CLAUDE,
  codex: CODEX,
  opencode: OPENCODE,
  gemini: GEMINI,
  pi: PI,
  hermes: HERMES,
  cursor: CURSOR,
};

/** All harness ids, in registry order. */
export const harnessIds: readonly HarnessId[] = harnessRegistry.map((h) => h.id);

/** Look up a descriptor by id. */
export function getHarness(id: HarnessId): HarnessDescriptor {
  return byId[id];
}

/**
 * Runtime hook events a harness has a handler for: the registered set plus the
 * legacy no-op handlers we keep. The hook runner uses this to decide whether to
 * dispatch a fired event or return the empty result.
 */
export function runtimeHookEvents(id: HarnessId): readonly string[] {
  const d = byId[id];
  return [...new Set([...d.hookEvents, ...d.legacyHandledEvents])];
}
