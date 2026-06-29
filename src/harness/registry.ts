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

export type HarnessId = 'claude' | 'codex' | 'opencode' | 'gemini' | 'pi';

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
   *     events and shells out (opencode `.opencode/plugins/*.ts`; later pi).
   * The install writer dispatches on this.
   */
  mechanism: 'json-hooks-map' | 'ts-plugin';
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

/** All supported harnesses, in display order. */
export const harnessRegistry: readonly HarnessDescriptor[] = [
  CLAUDE,
  CODEX,
  OPENCODE,
  GEMINI,
  PI,
];

const byId: Record<HarnessId, HarnessDescriptor> = {
  claude: CLAUDE,
  codex: CODEX,
  opencode: OPENCODE,
  gemini: GEMINI,
  pi: PI,
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
