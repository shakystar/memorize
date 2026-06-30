import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import which from 'which';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { type HarnessId, getHarness } from '../harness/registry.js';
import { isEnoent, writeJson } from '../storage/fs-utils.js';
import { POST_TOOL_USE_MATCHER } from './capture-service.js';

/**
 * Pick the fastest hook command form available on this machine. We do
 * this at install time (not hook fire time) so the choice is baked
 * into settings.json and stays predictable.
 *
 * Why it matters: Claude waits for SessionStart's output (it's
 * injected into context), so npx's ~500ms-2s of cold-cache resolution
 * is tolerable there. SessionEnd is non-blocking — Claude exits as
 * soon as the hook is fired, killing any subprocess that hadn't
 * finished yet. With `npx ...`, the npx wrapper barely starts node
 * before Claude reaps it; the actual cleanup never runs. With bare
 * `memorize`, the binary launches in milliseconds and the cleanup
 * completes in time.
 *
 * Override via MEMORIZE_HOOK_COMMAND_FORM=npx|bare for tests and
 * unusual deployments.
 */
type HookCommandForm = 'bare' | 'npx';

function detectHookCommandForm(): HookCommandForm {
  const override = process.env.MEMORIZE_HOOK_COMMAND_FORM;
  if (override === 'bare' || override === 'npx') return override;
  return which.sync('memorize', { nothrow: true }) ? 'bare' : 'npx';
}

/**
 * Absolute path to this package's CLI entrypoint (dist/cli/index.js),
 * resolved from the running module location and normalized to forward
 * slashes. #122 — Claude Code executes hooks via Git Bash, where the npm
 * global bin is NOT on PATH, so a bare `memorize` token fails
 * `command not found`. `node` is always resolvable; an absolute path to
 * cli/index.js removes shim/PATHEXT/PATH ambiguity while keeping the
 * ms-level startup the `bare` form was chosen for. Forward slashes work
 * both as a Git Bash command-string arg and for node on Windows.
 */
function resolveCliPath(): string {
  // This module is dist/services/install-service.js at runtime.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../cli/index.js').replace(/\\/g, '/');
}

function buildHookCommand(
  form: HookCommandForm,
  agent: HarnessId,
  event: string,
): string {
  return form === 'bare'
    ? `node "${resolveCliPath()}" hook ${agent} ${event}`
    : `npx @shakystar/memorize hook ${agent} ${event}`;
}

/**
 * Source-of-truth fragment that identifies a command as memorize's, no
 * matter the form. Precedes the `hook <agent> <event>` suffix:
 *   - npx form:  `npx @shakystar/memorize hook ...`
 *   - bare form (legacy): `memorize hook ...`
 *   - resolved-binary form (legacy, esp. Windows): a path to the launcher with
 *     an OS extension — `C:/.../npm/memorize.cmd hook ...` (also `.exe`/`.ps1`/
 *     `.bat`, quoted or not). Before #122, `which.sync('memorize')` returned the
 *     `.cmd` shim and install wrote it verbatim; the old token (which required
 *     whitespace immediately after `memorize`) MISSED the `.cmd` between name and
 *     `hook`, so these survived every re-install and DUPLICATED. Recognized now.
 *   - node-abs form (#122): `node "<.../memorize/.../dist/cli/index.js>" hook ...`
 *     — no `memorize` token adjacent to `hook`; identified instead by a
 *     path that contains `memorize` and ends in `cli/index.js`
 *     (or backslash variant for a Windows path written verbatim).
 *
 * A command is memorize's iff it carries one of these identifying tokens
 * AND the `hook <agent> <event>` suffix. Shared by install (strip/migrate)
 * and doctor (presence) so the two can never drift.
 */
const MEMORIZE_TOKEN =
  '(?:(?:@shakystar/)?memorize(?:\\.cmd|\\.exe|\\.ps1|\\.bat)?"?\\s+hook|memorize[^"\\s]*[/\\\\]cli[/\\\\]index\\.js"?\\s+hook)';

/**
 * Matches any historical or current memorize hook command shape so
 * re-installing migrates from one form to another (e.g. swap npx for
 * bare/node-abs when memorize lands on PATH, or strip a removed event
 * like Stop) without leaving duplicates.
 */
function isMemorizeHookCommandFor(
  command: string,
  agent: HarnessId,
  event: string,
): boolean {
  const re = new RegExp(`${MEMORIZE_TOKEN}\\s+${agent}\\s+${event}\\b`);
  return re.test(command);
}

/**
 * Doctor-side presence check: is `command` a memorize hook for `agent`
 * (any event, any form)? Shares MEMORIZE_TOKEN with the install strip so
 * doctor never reports a node-abs hook as missing. Exported for
 * repair-service.
 */
export function isMemorizeHookCommandForAgent(
  command: string,
  agent: HarnessId,
): boolean {
  const re = new RegExp(`${MEMORIZE_TOKEN}\\s+${agent}\\b`);
  return re.test(command);
}

// Hook event sets are owned by the harness registry (the single source of
// truth) — see src/harness/registry.ts for the per-event rationale. Re-exported
// here because repair-service (doctor) reads CLAUDE_HOOK_EVENTS to verify the
// SAME set install registers, so the two can never drift.
export const CLAUDE_HOOK_EVENTS = getHarness('claude').hookEvents;

// Per-event matcher for Claude hook registration. PostToolUse fires for
// every tool; matching here (instead of in the handler) saves a subprocess
// spawn per read-only tool call. The matcher is DERIVED from
// capture-service's whitelist (single source — decision ③), so the hook
// registration can never drift from the filter.
const CLAUDE_HOOK_MATCHERS: Partial<Record<string, string>> = {
  PostToolUse: POST_TOOL_USE_MATCHER,
};

// Legacy events a prior install may have registered that the current contract
// strips on re-install (registry-owned; preserves other tools' entries).
const CLAUDE_LEGACY_MEMORIZE_HOOK_EVENTS = getHarness('claude').legacyHookEvents;

// Claude Code expects each hook event to hold an array of matcher
// groups, where every group itself carries a `hooks` array of
// `{ type, command }` entries. Our earlier shape
// (`{ command }` only, no matcher, no `type`) is silently rejected at
// launch with "hooks: Expected array, but received undefined".
// See https://code.claude.com/docs/en/hooks for the schema.
interface HookEntry {
  type: 'command';
  command: string;
}

interface HookMatcherGroup {
  matcher?: string;
  hooks: HookEntry[];
}

type HooksMap = Record<string, HookMatcherGroup[]>;

function hookGroupHasCommand(
  group: HookMatcherGroup,
  command: string,
  matcher: string,
): boolean {
  return (
    (group.matcher ?? '') === matcher &&
    group.hooks.some((entry) => entry.command === command)
  );
}

function ensureMemorizeCommand(
  list: HookMatcherGroup[] | undefined,
  command: string,
  matcher: string = '',
): HookMatcherGroup[] {
  const current = list ?? [];
  if (current.some((group) => hookGroupHasCommand(group, command, matcher))) {
    return current;
  }
  return [
    ...current,
    {
      matcher,
      hooks: [{ type: 'command', command }],
    },
  ];
}

/**
 * Strip every memorize entry for a given (agent, event) regardless of
 * which command form (`npx ...` vs bare `memorize`) was used. This
 * lets re-install swap forms cleanly when memorize moves on/off PATH,
 * and lets us fully retire a hook (e.g. Stop in β) without leaving an
 * orphan entry pointing at a no-op handler. Other tools' entries
 * under the same event key are preserved.
 *
 * Returns undefined when removing our entries empties the event
 * entirely, so the caller can drop the event key from settings.
 */
function stripMemorizeForEvent(
  list: HookMatcherGroup[] | undefined,
  agent: HarnessId,
  event: string,
): HookMatcherGroup[] | undefined {
  if (!list) return undefined;
  const cleaned = list
    .map((group) => ({
      ...group,
      hooks: group.hooks.filter(
        (entry) => !isMemorizeHookCommandFor(entry.command, agent, event),
      ),
    }))
    .filter((group) => group.hooks.length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}

function coerceLegacyList(
  raw: unknown,
): HookMatcherGroup[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .map((entry): HookMatcherGroup | undefined => {
      if (entry && typeof entry === 'object') {
        const asGroup = entry as Partial<HookMatcherGroup> & {
          command?: string;
        };
        if (Array.isArray(asGroup.hooks)) {
          const hooks = asGroup.hooks
            .filter(
              (hook): hook is HookEntry =>
                hook !== null &&
                typeof hook === 'object' &&
                typeof (hook as HookEntry).command === 'string',
            )
            .map((hook) => ({
              type: 'command' as const,
              command: hook.command,
            }));
          return {
            ...(typeof asGroup.matcher === 'string'
              ? { matcher: asGroup.matcher }
              : { matcher: '' }),
            hooks,
          };
        }
        if (typeof asGroup.command === 'string') {
          // Legacy shape: `{command: "..."}` only. Migrate in place so the
          // file becomes Claude-Code-valid after re-running install.
          return {
            matcher: '',
            hooks: [{ type: 'command', command: asGroup.command }],
          };
        }
      }
      return undefined;
    })
    .filter((group): group is HookMatcherGroup => group !== undefined);
}

/**
 * Prepend a memorize hook entry so our context runs before other layers (the
 * codex placement). Dedups by command across all groups; OMITS the matcher key
 * when none is given — preserving codex's historical on-disk shape.
 */
function prependMemorizeCommand(
  list: HookMatcherGroup[] | undefined,
  command: string,
  matcher?: string,
): HookMatcherGroup[] {
  const current = list ?? [];
  if (
    current.some((group) => group.hooks.some((entry) => entry.command === command))
  ) {
    return current;
  }
  return [
    {
      ...(matcher !== undefined ? { matcher } : {}),
      hooks: [{ type: 'command', command }],
    },
    ...current,
  ];
}

interface HooksMapSpec {
  configPath: string;
  agent: HarnessId;
  /** Active events to register (this harness's NATIVE event names). */
  events: readonly string[];
  /** Events a prior install may have registered that we now strip. */
  legacyEvents: readonly string[];
  /** Append after the user's hooks (claude/gemini) or prepend before them (codex). */
  placement: 'append' | 'prepend';
  /** Per-event matcher (e.g. tool filter, or codex SessionStart 'startup|resume'). */
  matchers: Partial<Record<string, string>>;
}

/**
 * Shared json-hooks-map writer for every harness in that family (Claude, Codex,
 * Gemini). Reads the settings/hooks JSON, migrates legacy entry shapes, strips
 * every memorize entry across (events ∪ legacyEvents) in any command form, then
 * re-adds memorize entries for `events` with the freshly resolved command form.
 * Other tools' entries and other settings keys are preserved. Per-harness
 * divergence is JUST the spec: `append` defaults the matcher to '' (always
 * present, claude's shape); `prepend` omits the matcher key when none (codex's
 * shape) — so each harness's exact on-disk output is preserved.
 */
async function writeHooksMap(spec: HooksMapSpec): Promise<void> {
  let settings: { hooks?: Record<string, unknown> } = {};
  try {
    settings = JSON.parse(await fs.readFile(spec.configPath, 'utf8')) as {
      hooks?: Record<string, unknown>;
    };
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }

  const migrated: HooksMap = {};
  for (const [event, value] of Object.entries(settings.hooks ?? {})) {
    const groups = coerceLegacyList(value);
    if (groups) migrated[event] = groups;
  }

  const form = detectHookCommandForm();
  const purged: HooksMap = { ...migrated };
  for (const event of [...spec.events, ...spec.legacyEvents]) {
    const cleaned = stripMemorizeForEvent(purged[event], spec.agent, event);
    if (cleaned) purged[event] = cleaned;
    else delete purged[event];
  }

  const rebuilt: HooksMap = { ...purged };
  for (const event of spec.events) {
    const command = buildHookCommand(form, spec.agent, event);
    rebuilt[event] =
      spec.placement === 'prepend'
        ? prependMemorizeCommand(purged[event], command, spec.matchers[event])
        : ensureMemorizeCommand(purged[event], command, spec.matchers[event] ?? '');
  }

  await writeJson(spec.configPath, { ...settings, hooks: rebuilt });
}

export async function installClaudeIntegration(cwd: string): Promise<string> {
  const settingsPath = path.join(cwd, '.claude', 'settings.local.json');
  await writeHooksMap({
    configPath: settingsPath,
    agent: 'claude',
    events: CLAUDE_HOOK_EVENTS,
    legacyEvents: CLAUDE_LEGACY_MEMORIZE_HOOK_EVENTS,
    placement: 'append',
    matchers: CLAUDE_HOOK_MATCHERS,
  });
  // #68 — plant the single-source-of-truth contract where every Claude
  // session reads it. Default-on; the install command announces it.
  await upsertGroundRuleBlock(path.join(cwd, 'CLAUDE.md'));
  // Plant the using-memorize Agent Skill so sessions know when to reach for
  // memorize. Codex skills dir / tool names differ — follow-up.
  await writeUsingMemorizeSkill(cwd);
  return settingsPath;
}

// --- using-memorize Agent Skill ----------------------------------------------

const USING_MEMORIZE_SKILL = `---
name: using-memorize
description: Use when you need to recall cross-session decisions/progress or "why did we decide X"; check whether memorize's memory capture is healthy; or import pre-existing notes into the shared project brain — for projects using memorize.
---

# Using memorize

## Overview
memorize is the project's shared brain: past decisions, rationale, and cross-session progress in a local DB — NOT in the repo's files. Grep finds what was written to disk; memorize finds what was decided in conversation or by other sessions and never written down.

## When to use
- **Recall** — what another or earlier session worked on, decided, or handed off; a decision/rationale discussed but not in any doc; "what did we decide / why did we choose X" when the repo has no clear answer.
- **Health** — checking whether memory capture / consolidation is actually working.
- **Import** — getting pre-existing notes/decisions into the shared brain.

## When NOT to use
- The answer lives in code or docs → grep/read the files. memorize does not replace reading the repo.
- A single file/function lookup → Glob/Grep/Read.

For recall, grep silently omits conversation-only decisions — so for "what did we decide" or cross-session questions, check memorize even when grep returned something.

## Recall
\`memorize search "<query>"\` · \`memorize task resume\` · \`memorize session activity\`

\`memorize search\` returns truncated snippets — to read a memory's full text, open the source it cites (often a \`docs/\` spec).

## Health — "is capture/consolidation working?"
Run \`memorize doctor\` (add \`--json\` for detail). Trust its output — it aggregates hooks, watermarks, last attempt, and pending observations. Do NOT hand-query the SQLite DB to reconstruct health, and do NOT run \`memorize consolidate\` to "check" — that executes a real consolidation boundary (side effect).

## Import pre-existing notes into shared memory
\`memorize memory import --source <label>\`, piping a JSON array on stdin:
\`[{"kind":"decision|rationale|progress","text":"...","salience":1-10}]\`. Idempotent (dedup by kind+text). That's the full schema — don't read source to rediscover it.

## Conventions
Use the \`memorize\` binary directly (not \`node dist/...\`).

## Common mistake
Answering a cross-session or "why did we decide" question from grep alone and calling it complete — grep can't see decisions only ever spoken in conversation.
`;

/**
 * Plant the using-memorize Agent Skill at
 * <cwd>/.claude/skills/using-memorize/SKILL.md. Idempotent — overwrites on
 * every (re)install so the content stays current. Mirrors the #68
 * ground-rule block's managed-content style.
 */
async function writeUsingMemorizeSkill(cwd: string): Promise<void> {
  const skillDir = path.join(cwd, '.claude', 'skills', 'using-memorize');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), USING_MEMORIZE_SKILL, 'utf8');
}

/**
 * Remove the using-memorize skill directory (only that dir; sibling skills
 * are left alone). Never throws when absent.
 */
async function removeUsingMemorizeSkill(cwd: string): Promise<void> {
  const skillDir = path.join(cwd, '.claude', 'skills', 'using-memorize');
  await fs.rm(skillDir, { recursive: true, force: true });
}

// --- init-memorize Agent Skill (global) --------------------------------------

const INIT_MEMORIZE_SKILL = `---
name: init-memorize
description: Use when the user wants to set up / onboard / install memorize in a project for the first time ("set up memorize here", "add memorize to this repo", "onboard memorize"). For a one-shot project onboarding. NOT for recalling memory or checking health — that is the using-memorize skill.
---

# Setting up memorize in a project

## Overview
memorize gives every agent session a shared, persistent project brain. Onboarding a project is a single idempotent command — do NOT hand-run the old four-step flow (\`project init\` + \`project setup\` + \`install claude\` + \`install codex\`).

## When to use
The user asks to set up, onboard, or install memorize in THIS project for the first time.

## When NOT to use
- Recalling decisions / progress, or checking capture health → that is the \`using-memorize\` skill.
- The project is already set up (\`.claude/settings.local.json\` already has memorize hooks) → re-running \`init\` is safe but usually unnecessary; run \`memorize doctor\` instead.

## Steps
1. **Ensure \`memorize\` is on PATH.** Node project: \`npm install -D @shakystar/memorize\`. Otherwise: \`npm install -g @shakystar/memorize\`. (See AI_SETUP.md step 1 for monorepo / global-dir edge cases.)
2. **Run the one-shot onboarding** from the project root:
   \`npx @shakystar/memorize init\`
   Binds the directory to a memorize project (creating one if needed), imports existing AGENTS.md/CLAUDE.md/GEMINI.md/.cursorrules, detects installed agent CLIs, and wires each present agent. Safe to re-run. Add \`--nested\` to create a SEPARATE project inside an already-bound directory.
   If the output prints an **ACTION REQUIRED** notice for Codex, relay it verbatim — codex silently ignores externally-written hooks until the user approves them once interactively.
3. **Verify:** \`npx @shakystar/memorize doctor --json\` — expect \`"status": "ok"\`. If \`warn\`/\`error\`, apply each issue's \`fix\` field and re-run.
4. **Tell the user** memorize is set up and context now persists across sessions automatically. Do NOT tell them to create a task (an empty task list is normal).

## Common mistake
Running \`project init\` then \`project setup\` then \`install claude\`/\`install codex\` separately. \`memorize init\` does all of it in one idempotent step; the split commands are low-level escape hatches.
`;

/**
 * Global Claude skills dir (~/.claude/skills). Unlike using-memorize (planted
 * per-project by installClaudeIntegration), the init-memorize trigger must
 * exist BEFORE any project is set up, so it lives user-global.
 */
function globalClaudeSkillsDir(): string {
  return path.join(os.homedir(), '.claude', 'skills');
}

/**
 * Plant the init-memorize skill at ~/.claude/skills/init-memorize/SKILL.md so
 * any project gains a natural-language "set up memorize here" → `memorize init`
 * trigger. Idempotent — overwrites on every call to keep content current.
 * Called by `memorize setup` (the once-per-machine global onboarding) when
 * Claude Code is detected.
 */
export async function installInitMemorizeSkill(): Promise<string> {
  const skillDir = path.join(globalClaudeSkillsDir(), 'init-memorize');
  await fs.mkdir(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, 'SKILL.md');
  await fs.writeFile(skillPath, INIT_MEMORIZE_SKILL, 'utf8');
  return skillPath;
}

/**
 * Remove the global init-memorize skill dir (only that dir). Never throws when
 * absent. Exported for an explicit teardown path; not wired into per-project
 * `uninstall claude` (that would surprisingly affect every project).
 */
export async function removeInitMemorizeSkill(): Promise<void> {
  await fs.rm(path.join(globalClaudeSkillsDir(), 'init-memorize'), {
    recursive: true,
    force: true,
  });
}

// --- #68 ground-rule block ----------------------------------------------------

const GROUND_RULE_START_MARKER = '<!-- memorize:ground-rule v=1 start -->';
const GROUND_RULE_END_MARKER = '<!-- memorize:ground-rule v=1 end -->';

/**
 * #68 — the single-source-of-truth contract, planted in the agent's standing
 * instruction file (CLAUDE.md / AGENTS.md) so it reaches sessions that never
 * read AGENT_GUIDE. A behavioral contract, NOT context — deliberately unlike
 * the removed pre-v0.2 bootstrap block, which duplicated hook-injected
 * context. Managed: re-install replaces it in place, uninstall strips it.
 */
const GROUND_RULE_BLOCK = [
  GROUND_RULE_START_MARKER,
  '## Memorize ground rule',
  '',
  'Memorize is the single source of truth for project state. Do not store',
  'project ids, task lists, decisions, handoffs, or summaries of them in',
  'your own memory system — they go stale silently. Query memorize at',
  'session start instead (`memorize task resume`, `memorize project show`).',
  'Your own memory is for per-self content only: user preferences and your',
  'own working-style lessons. To absorb pre-existing notes into memorize,',
  'see `memorize memory import` in AGENT_GUIDE.md.',
  GROUND_RULE_END_MARKER,
].join('\n');

/**
 * Insert or refresh the ground-rule block in a user-owned instruction file.
 * Creates the file when absent; otherwise replaces an existing block in
 * place (any older content between the markers is upgraded) or appends the
 * block after the user's content. Returns the path it wrote.
 */
async function upsertGroundRuleBlock(filePath: string): Promise<string> {
  let existing: string | undefined;
  try {
    existing = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  if (existing === undefined) {
    await fs.writeFile(filePath, `${GROUND_RULE_BLOCK}\n`, 'utf8');
    return filePath;
  }
  const bounds = locateBlock(
    existing,
    GROUND_RULE_START_MARKER,
    GROUND_RULE_END_MARKER,
  );
  const next = bounds
    ? existing.slice(0, bounds.startIndex) +
      GROUND_RULE_BLOCK +
      existing.slice(bounds.afterEndIndex)
    : `${existing.trimEnd()}\n\n${GROUND_RULE_BLOCK}\n`;
  if (next !== existing) {
    await fs.writeFile(filePath, next, 'utf8');
  }
  return filePath;
}

/**
 * Strip the ground-rule block, byte-preserving everything else. NEVER
 * deletes the file — CLAUDE.md / AGENTS.md are user-owned, even when the
 * block was their only content (we may have created the file, but by now
 * the user may consider it theirs).
 */
async function stripGroundRuleBlock(filePath: string): Promise<void> {
  let existing: string;
  try {
    existing = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  const bounds = locateBlock(
    existing,
    GROUND_RULE_START_MARKER,
    GROUND_RULE_END_MARKER,
  );
  if (!bounds) return;
  const before = existing.slice(0, bounds.startIndex);
  const after = existing.slice(bounds.afterEndIndex);
  // Collapse the blank line the append path introduced, byte-preserving the
  // user's own content on both sides otherwise.
  const cleaned =
    before.replace(/\n+$/, (m) => (after.startsWith('\n') ? m.slice(0, -1) : m)) +
    after.replace(/^\n/, '');
  await fs.writeFile(filePath, cleaned, 'utf8');
}

const CODEX_START_MARKER = '<!-- memorize:bootstrap v=1 start -->';
const CODEX_END_MARKER = '<!-- memorize:bootstrap v=1 end -->';
const LEGACY_CODEX_START_MARKER = '<!-- Memorize:START -->';
const LEGACY_CODEX_END_MARKER = '<!-- Memorize:END -->';

// Codex hook event sets (registry-owned; see registry.ts for rationale).
const CODEX_HOOK_EVENTS = getHarness('codex').hookEvents;
const CODEX_LEGACY_MEMORIZE_HOOK_EVENTS = getHarness('codex').legacyHookEvents;

function codexHooksPath(): string {
  return path.join(os.homedir(), '.codex', 'hooks.json');
}

export async function installCodexHooks(): Promise<string> {
  const hooksPath = codexHooksPath();
  // Prepend so memorize's context is established before any other layer (OMX,
  // third-party). Codex SessionStart wants matcher 'startup|resume'.
  await writeHooksMap({
    configPath: hooksPath,
    agent: 'codex',
    events: CODEX_HOOK_EVENTS,
    legacyEvents: CODEX_LEGACY_MEMORIZE_HOOK_EVENTS,
    placement: 'prepend',
    matchers: { SessionStart: 'startup|resume' },
  });
  return hooksPath;
}

interface BlockBounds {
  startIndex: number;
  afterEndIndex: number;
}

function locateBlock(
  source: string,
  startMarker: string,
  endMarker: string,
): BlockBounds | undefined {
  const startIndex = source.indexOf(startMarker);
  if (startIndex === -1) return undefined;
  const endMarkerIndex = source.indexOf(endMarker, startIndex + startMarker.length);
  if (endMarkerIndex === -1) return undefined;
  return {
    startIndex,
    afterEndIndex: endMarkerIndex + endMarker.length,
  };
}

function stripLegacyBlock(source: string): string {
  const bounds = locateBlock(
    source,
    LEGACY_CODEX_START_MARKER,
    LEGACY_CODEX_END_MARKER,
  );
  if (!bounds) return source;
  const before = source.slice(0, bounds.startIndex).trimEnd();
  const after = source.slice(bounds.afterEndIndex).replace(/^\n+/, '');
  if (before.length === 0 && after.length === 0) return '';
  if (before.length === 0) return `${after}\n`;
  if (after.length === 0) return `${before}\n`;
  return `${before}\n\n${after}\n`;
}

function stripLegacyMemorizeBlock(source: string): string {
  let out = source;
  // Strip v=1 block.
  const v1 = locateBlock(out, CODEX_START_MARKER, CODEX_END_MARKER);
  if (v1) {
    const before = out.slice(0, v1.startIndex).trimEnd();
    const after = out.slice(v1.afterEndIndex).replace(/^\n+/, '');
    if (before.length === 0 && after.length === 0) {
      out = '';
    } else if (before.length === 0) {
      out = `${after}\n`;
    } else if (after.length === 0) {
      out = `${before}\n`;
    } else {
      out = `${before}\n\n${after}\n`;
    }
  }
  // Also strip the pre-v=1 legacy marker via the existing stripLegacyBlock helper.
  out = stripLegacyBlock(out);
  return out;
}

async function stripMemorizeFromFile(
  filePath: string,
  options: { deleteIfEmpty: boolean },
): Promise<void> {
  let existing: string;
  try {
    existing = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  const cleaned = stripLegacyMemorizeBlock(existing);
  if (cleaned === existing) return;
  if (options.deleteIfEmpty && cleaned.trim().length === 0) {
    await fs.unlink(filePath);
    return;
  }
  await fs.writeFile(filePath, cleaned, 'utf8');
}

/**
 * Strip every memorize hook entry (all command forms) across the given events
 * from a raw hooks map, preserving other tools' entries. Shared by the claude
 * and codex uninstall paths. Mirrors install's coerce→strip pipeline so an
 * uninstall faithfully reverses what install wrote.
 */
function stripAllMemorizeHooks(
  rawHooks: Record<string, unknown>,
  agent: HarnessId,
  events: readonly string[],
): HooksMap {
  const migrated: HooksMap = {};
  for (const [event, value] of Object.entries(rawHooks)) {
    const groups = coerceLegacyList(value);
    if (groups) migrated[event] = groups;
  }
  const cleaned: HooksMap = { ...migrated };
  for (const event of events) {
    const stripped = stripMemorizeForEvent(cleaned[event], agent, event);
    if (stripped) {
      cleaned[event] = stripped;
    } else {
      delete cleaned[event];
    }
  }
  return cleaned;
}

/**
 * Remove memorize's Claude integration: strip every memorize hook entry (active
 * + legacy events, all command forms) from `.claude/settings.local.json`,
 * preserving the user's other hooks and settings keys. Idempotent — a missing
 * file or an already-clean file is a silent no-op. Captured data (events/db) is
 * NOT touched; this reverses `install`, not the memory itself.
 */
export async function uninstallClaudeIntegration(cwd: string): Promise<string> {
  const settingsPath = path.join(cwd, '.claude', 'settings.local.json');
  // Strip the #68 block first — it must come out even when the settings
  // file is already gone (manually deleted, partial uninstall).
  await stripGroundRuleBlock(path.join(cwd, 'CLAUDE.md'));
  // Remove the using-memorize skill (no-op when absent); leave sibling skills.
  await removeUsingMemorizeSkill(cwd);
  let settings: { hooks?: Record<string, unknown> } = {};
  try {
    settings = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as {
      hooks?: Record<string, unknown>;
    };
  } catch (error) {
    if (isEnoent(error)) return settingsPath; // nothing installed
    throw error;
  }

  const cleaned = stripAllMemorizeHooks(settings.hooks ?? {}, 'claude', [
    ...CLAUDE_HOOK_EVENTS,
    ...CLAUDE_LEGACY_MEMORIZE_HOOK_EVENTS,
  ]);

  const merged: { hooks?: Record<string, unknown> } = { ...settings };
  if (Object.keys(cleaned).length > 0) {
    merged.hooks = cleaned;
  } else {
    delete merged.hooks;
  }
  await writeJson(settingsPath, merged);
  return settingsPath;
}

/**
 * Remove memorize's Codex integration: strip memorize entries from
 * `~/.codex/hooks.json` (preserving others) and remove any historical memorize
 * blocks from AGENTS.override.md / AGENTS.md. Idempotent; data untouched. Codex
 * hook-trust state is codex's own — nothing to undo there.
 */
export async function uninstallCodexIntegration(cwd: string): Promise<string> {
  const hooksPath = codexHooksPath();
  let settings: { hooks?: Record<string, unknown> } | undefined;
  try {
    settings = JSON.parse(await fs.readFile(hooksPath, 'utf8')) as {
      hooks?: Record<string, unknown>;
    };
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }

  if (settings) {
    const cleaned = stripAllMemorizeHooks(settings.hooks ?? {}, 'codex', [
      ...CODEX_HOOK_EVENTS,
      ...CODEX_LEGACY_MEMORIZE_HOOK_EVENTS,
    ]);
    const merged: { hooks?: Record<string, unknown> } = { ...settings };
    if (Object.keys(cleaned).length > 0) {
      merged.hooks = cleaned;
    } else {
      delete merged.hooks;
    }
    await writeJson(hooksPath, merged);
  }

  // Reverse any historical AGENTS injection (no-op when absent).
  await stripMemorizeFromFile(path.join(cwd, 'AGENTS.override.md'), {
    deleteIfEmpty: true,
  });
  await stripMemorizeFromFile(path.join(cwd, 'AGENTS.md'), {
    deleteIfEmpty: false,
  });
  // #68 — reverse the ground-rule block; the file itself stays (user-owned).
  await stripGroundRuleBlock(path.join(cwd, 'AGENTS.md'));
  return hooksPath;
}

export async function installCodexIntegration(cwd: string): Promise<string> {
  const hooksPath = await installCodexHooks();

  // AGENTS.override.md was the historical injection target — memorize
  // owned it, so when our content is removed and the file is otherwise
  // empty we delete it.
  await stripMemorizeFromFile(path.join(cwd, 'AGENTS.override.md'), {
    deleteIfEmpty: true,
  });
  // AGENTS.md is user-owned. Earlier install variants also injected
  // here; we still strip those blocks for cleanup, but never delete the
  // file even if the strip leaves it empty — that decision belongs to
  // the user.
  await stripMemorizeFromFile(path.join(cwd, 'AGENTS.md'), {
    deleteIfEmpty: false,
  });
  // #68 — plant the single-source-of-truth contract where every codex
  // session reads it (AFTER the legacy strip so it survives the cleanup).
  await upsertGroundRuleBlock(path.join(cwd, 'AGENTS.md'));

  return hooksPath;
}

// --- Gemini CLI (json-hooks-map) ---------------------------------------------

const GEMINI_HOOK_EVENTS = getHarness('gemini').hookEvents;

function geminiSettingsPath(): string {
  return path.join(os.homedir(), '.gemini', 'settings.json');
}

/**
 * Wire memorize into Gemini CLI via ~/.gemini/settings.json hooks (schema
 * identical to Claude's). SessionStart injects context through the same
 * `hookSpecificOutput.additionalContext` field; `AfterTool` → PostToolUse
 * capture (routed by the descriptor's eventHandlerMap). Global scope — bails at
 * runtime when the cwd is unbound (like codex). Plants the GEMINI.md ground
 * rule. Idempotent.
 */
export async function installGeminiIntegration(cwd: string): Promise<string> {
  const settingsPath = geminiSettingsPath();
  await writeHooksMap({
    configPath: settingsPath,
    agent: 'gemini',
    events: GEMINI_HOOK_EVENTS,
    legacyEvents: [],
    placement: 'append',
    // AfterTool tool matcher (and the capture filter's gemini tool names) are
    // pinned via conformance dogfood; capture-all until then.
    matchers: {},
  });
  await upsertGroundRuleBlock(path.join(cwd, 'GEMINI.md'));
  return settingsPath;
}

/**
 * Reverse installGeminiIntegration: strip memorize hooks from
 * ~/.gemini/settings.json (preserving other hooks/keys) and the GEMINI.md
 * ground-rule block. Idempotent; captured data untouched.
 */
export async function uninstallGeminiIntegration(cwd: string): Promise<string> {
  const settingsPath = geminiSettingsPath();
  let settings: { hooks?: Record<string, unknown> } | undefined;
  try {
    settings = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as {
      hooks?: Record<string, unknown>;
    };
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  if (settings) {
    const cleaned = stripAllMemorizeHooks(
      settings.hooks ?? {},
      'gemini',
      GEMINI_HOOK_EVENTS,
    );
    const merged: { hooks?: Record<string, unknown> } = { ...settings };
    if (Object.keys(cleaned).length > 0) merged.hooks = cleaned;
    else delete merged.hooks;
    await writeJson(settingsPath, merged);
  }
  await stripGroundRuleBlock(path.join(cwd, 'GEMINI.md'));
  return settingsPath;
}

// --- opencode (TS-plugin mechanism) ------------------------------------------

// opencode integrates via three surfaces, NOT a JSON hooks map:
//   1. MCP server registered in opencode.json `mcp` — delivers session-start
//      memory (memorize_context) + recall/record/diagnose. This is opencode's
//      session-start path because its plugin API has no session-start hook.
//   2. A TS plugin (~/.config/opencode/plugins/memorize.ts) that auto-captures
//      tool use (tool.execute.after) and runs the consolidation boundary at
//      compaction. Planted as a template string (NOT part of memorize's own
//      build, so it is neither typechecked nor linted here).
//   3. The AGENTS.md ground-rule block, surfaced via opencode's `instructions`.

function opencodeConfigDir(): string {
  return path.join(os.homedir(), '.config', 'opencode');
}

function opencodeConfigPath(): string {
  return path.join(opencodeConfigDir(), 'opencode.json');
}

function opencodePluginPath(): string {
  return path.join(opencodeConfigDir(), 'plugins', 'memorize.ts');
}

/**
 * The spawn command a planted TS plugin/extension uses to reach THIS memorize
 * install (shared by opencode and pi). Mirrors buildHookCommand's form choice so
 * the plugin invokes the same binary the install resolved — node-abs when
 * memorize is installed (crucial: avoids fetching the *published* npm package,
 * which lacks unreleased harness support, and is what the conformance container
 * relies on), else npx.
 */
function tsPluginSpawnSpec(): { cmd: string; argsPrefix: string[] } {
  return detectHookCommandForm() === 'bare'
    ? { cmd: 'node', argsPrefix: [resolveCliPath()] }
    : { cmd: 'npx', argsPrefix: ['-y', '@shakystar/memorize'] };
}

// Planted verbatim at install. opencode runs on Bun, which supports
// node:child_process, so the spawn path avoids depending on Bun-shell stdin
// specifics. LIVE-VERIFICATION NOTE: opencode's plugin payload field names and
// built-in tool names are not fully pinned in the docs — the field reads and
// the tool-name map below are best-effort and must be confirmed against a live
// opencode session (the conformance harness / dogfood item). Capture failing
// must never break the opencode session, hence the broad try/catch + detached
// fire-and-forget.
function renderOpencodePlugin(spec: { cmd: string; argsPrefix: string[] }): string {
  return `// memorize opencode plugin — planted by \`memorize install opencode\`.
// Do not edit by hand; re-running install overwrites it.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Baked at install time so the plugin reaches the same memorize the install used.
const SPAWN_CMD = ${JSON.stringify(spec.cmd)};
const SPAWN_ARGS_PREFIX = ${JSON.stringify(spec.argsPrefix)};

// Diagnostics: MEMORIZE_OPENCODE_DEBUG=1 dumps payloads + spawn outcomes to
// ~/memorize-opencode-debug.log. Off by default; used by the conformance
// harness to pin opencode's real tool.execute.after shape and tool names.
const DEBUG = !!process.env.MEMORIZE_OPENCODE_DEBUG;
function dbg(obj) {
  if (!DEBUG) return;
  try {
    appendFileSync(join(homedir(), 'memorize-opencode-debug.log'), JSON.stringify(obj) + '\\n');
  } catch {}
}

// opencode tool names -> the names memorize's capture filter recognizes.
const TOOL_NAME_MAP = { write: 'Write', edit: 'Edit', patch: 'Edit', bash: 'shell' };

function fireMemorizeHook(event, payload) {
  try {
    const child = spawn(SPAWN_CMD, [...SPAWN_ARGS_PREFIX, 'hook', 'opencode', event], {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
    });
    child.on('error', (e) => dbg({ spawnError: String(e), cmd: SPAWN_CMD, args: SPAWN_ARGS_PREFIX }));
    if (child.stdin) child.stdin.end(JSON.stringify(payload || {}));
    child.unref();
    dbg({ fired: event, payload });
  } catch (e) {
    dbg({ fireError: String(e) });
    // capture is best-effort; never break the opencode session
  }
}

export const MemorizePlugin = async () => ({
  'tool.execute.after': async (input, output) => {
    const rawTool = (input && (input.tool || input.toolName)) || (output && output.tool) || '';
    dbg({
      hook: 'tool.execute.after',
      rawTool,
      mapped: TOOL_NAME_MAP[rawTool] || rawTool,
      cwd: process.cwd(),
      inputKeys: Object.keys(input || {}),
      outputKeys: Object.keys(output || {}),
      input,
      output,
    });
    fireMemorizeHook('PostToolUse', {
      tool_name: TOOL_NAME_MAP[rawTool] || rawTool,
      tool_input: (input && (input.args || input.input)) || {},
    });
  },
  'experimental.session.compacting': async (input, output) => {
    fireMemorizeHook('PostCompact', { compact_summary: (input && input.summary) || '' });
    // opencode has no session-start-injection hook; after a compaction, point
    // the model back at the memorize MCP server to reload project memory.
    try {
      if (output && output.context && typeof output.context.push === 'function') {
        output.context.push('Memorize: call the \\\`memorize_context\\\` MCP tool to reload project memory.');
      }
    } catch {
      // tolerate opencode API drift
    }
  },
});
`;
}

interface OpencodeConfig {
  $schema?: string;
  instructions?: string[];
  mcp?: Record<string, unknown>;
  [key: string]: unknown;
}

const MEMORIZE_MCP_KEY = 'memorize';

async function readOpencodeConfig(): Promise<OpencodeConfig> {
  try {
    const raw = await fs.readFile(opencodeConfigPath(), 'utf8');
    const parsed = JSON.parse(raw) as OpencodeConfig;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (isEnoent(error)) return {};
    throw error;
  }
}

/**
 * Register the memorize MCP server in opencode.json (idempotent merge) and
 * ensure AGENTS.md is in the `instructions` list so opencode loads the
 * ground-rule. Preserves the user's other config keys.
 */
async function mergeOpencodeConfig(): Promise<string> {
  const config = await readOpencodeConfig();
  config.$schema = config.$schema ?? 'https://opencode.ai/config.json';
  config.mcp = { ...(config.mcp ?? {}) };
  config.mcp[MEMORIZE_MCP_KEY] = {
    type: 'local',
    command: ['npx', '-y', '@shakystar/memorize', 'mcp'],
    enabled: true,
  };
  const instructions = Array.isArray(config.instructions)
    ? [...config.instructions]
    : [];
  if (!instructions.includes('AGENTS.md')) instructions.push('AGENTS.md');
  config.instructions = instructions;
  const configPath = opencodeConfigPath();
  await writeJson(configPath, config);
  return configPath;
}

async function writeOpencodePlugin(): Promise<void> {
  const pluginPath = opencodePluginPath();
  await fs.mkdir(path.dirname(pluginPath), { recursive: true });
  await fs.writeFile(pluginPath, renderOpencodePlugin(tsPluginSpawnSpec()), 'utf8');
}

/**
 * Wire memorize into opencode: register the MCP server + AGENTS.md instruction
 * (global opencode.json), plant the capture plugin (global), and plant the
 * project's AGENTS.md ground-rule block. Idempotent. Returns the opencode.json
 * path (the primary config surface) for the install summary.
 */
export async function installOpencodeIntegration(cwd: string): Promise<string> {
  const configPath = await mergeOpencodeConfig();
  await writeOpencodePlugin();
  await upsertGroundRuleBlock(path.join(cwd, 'AGENTS.md'));
  return configPath;
}

/**
 * Reverse installOpencodeIntegration: drop the memorize MCP entry, remove the
 * plugin file, and strip the AGENTS.md ground-rule. Preserves other opencode
 * config and never deletes user-owned AGENTS.md. Idempotent.
 */
export async function uninstallOpencodeIntegration(cwd: string): Promise<string> {
  const configPath = opencodeConfigPath();
  const config = await readOpencodeConfig();
  if (config.mcp && MEMORIZE_MCP_KEY in config.mcp) {
    const mcp = { ...config.mcp };
    delete mcp[MEMORIZE_MCP_KEY];
    config.mcp = mcp;
    await writeJson(configPath, config);
  }
  await fs.rm(opencodePluginPath(), { force: true });
  await stripGroundRuleBlock(path.join(cwd, 'AGENTS.md'));
  return configPath;
}

// --- pi (TS-extension mechanism) ---------------------------------------------

// pi (earendil-works/pi) is the same ts-plugin family as opencode but with a
// richer hook surface, so it integrates via three surfaces:
//   1. A TS extension (~/.pi/agent/extensions/memorize.ts) that subscribes to
//      pi lifecycle events: `before_agent_start` (→ inject session-start memory
//      ONCE per session — pi's hook CAN inject a model message, unlike
//      opencode's), `tool_result` (→ PostToolUse capture), `session_compact`
//      (→ PostCompact boundary). Planted as a template string (NOT part of
//      memorize's own build, so neither typechecked nor linted here).
//   2. An MCP block merged into ~/.pi/agent/mcp.json (Claude-format) so an
//      MCP-capable pi setup (community extension / my-pi) also exposes memorize
//      tools. Additive: session-start memory does NOT depend on it (the
//      before_agent_start hook delivers that).
//   3. The AGENTS.md ground-rule block — pi reads AGENTS.md natively.

function piAgentDir(): string {
  return path.join(os.homedir(), '.pi', 'agent');
}

function piExtensionPath(): string {
  return path.join(piAgentDir(), 'extensions', 'memorize.ts');
}

function piMcpConfigPath(): string {
  return path.join(piAgentDir(), 'mcp.json');
}

// Planted verbatim at install. pi loads extensions as ES modules (Node/Bun
// compatible), so the spawn path uses node:child_process. Capture/injection
// failing must NEVER break the pi session, hence broad try/catch and a bounded
// wait on the session-start fetch. LIVE-VERIFICATION NOTE: pi's event payload
// field names and built-in tool names are grounded from the docs (toolName is
// lowercase write/edit/bash); the conformance harness pins them against the
// real CLI.
function renderPiExtension(spec: { cmd: string; argsPrefix: string[] }): string {
  return `// memorize pi extension — planted by \`memorize init\` (pi detected).
// Do not edit by hand; re-running install overwrites it.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Baked at install time so the extension reaches the same memorize the install used.
const SPAWN_CMD = ${JSON.stringify(spec.cmd)};
const SPAWN_ARGS_PREFIX = ${JSON.stringify(spec.argsPrefix)};

// Diagnostics: MEMORIZE_PI_DEBUG=1 dumps payloads + spawn outcomes to
// ~/memorize-pi-debug.log. Off by default; used by the conformance harness.
const DEBUG = !!process.env.MEMORIZE_PI_DEBUG;
function dbg(obj) {
  if (!DEBUG) return;
  try {
    appendFileSync(join(homedir(), 'memorize-pi-debug.log'), JSON.stringify(obj) + '\\n');
  } catch {}
}

// pi built-in tool names (lowercase) -> the names memorize's capture filter knows.
const TOOL_NAME_MAP = { write: 'Write', edit: 'Edit', patch: 'Edit', bash: 'shell' };

// Fire-and-forget hook (capture / compaction): never blocks the pi turn.
function fireMemorizeHook(event, payload) {
  try {
    const child = spawn(SPAWN_CMD, [...SPAWN_ARGS_PREFIX, 'hook', 'pi', event], {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
    });
    child.on('error', (e) => dbg({ spawnError: String(e), event }));
    if (child.stdin) child.stdin.end(JSON.stringify(payload || {}));
    child.unref();
    dbg({ fired: event, payload });
  } catch (e) {
    dbg({ fireError: String(e) });
  }
}

// Session-start memory: run \`memorize hook pi SessionStart\`, CAPTURE its stdout
// JSON, and return the injected context. Bounded so a slow/hung memorize never
// stalls the pi session; resolves '' on any failure (best-effort).
function memorizeSessionContext() {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const child = spawn(SPAWN_CMD, [...SPAWN_ARGS_PREFIX, 'hook', 'pi', 'SessionStart'], {
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const timer = setTimeout(() => { try { child.kill(); } catch {} finish(''); }, 8000);
      child.on('error', (e) => { clearTimeout(timer); dbg({ ctxSpawnError: String(e) }); finish(''); });
      if (child.stdout) child.stdout.on('data', (d) => { out += d; });
      child.on('close', () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(out);
          const ctx = parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext;
          finish(typeof ctx === 'string' ? ctx : '');
        } catch (e) { dbg({ ctxParseError: String(e), out }); finish(''); }
      });
      if (child.stdin) child.stdin.end('{}');
    } catch (e) { dbg({ ctxError: String(e) }); finish(''); }
  });
}

// before_agent_start fires every user turn; gate injection to ONCE per session.
let memorizeInjected = false;

export default function (pi) {
  pi.on('before_agent_start', async (event) => {
    if (memorizeInjected) return;
    memorizeInjected = true; // set first: never re-spawn within a session
    const ctx = await memorizeSessionContext();
    dbg({ hook: 'before_agent_start', injectedChars: (ctx || '').length });
    if (!ctx) return;
    return { message: { customType: 'memorize', content: ctx, display: false } };
  });

  pi.on('tool_result', async (event) => {
    const rawTool = (event && (event.toolName || event.tool)) || '';
    dbg({ hook: 'tool_result', rawTool, mapped: TOOL_NAME_MAP[rawTool] || rawTool, cwd: process.cwd() });
    fireMemorizeHook('PostToolUse', {
      tool_name: TOOL_NAME_MAP[rawTool] || rawTool,
      tool_input: (event && event.input) || {},
    });
  });

  pi.on('session_compact', async (event) => {
    fireMemorizeHook('PostCompact', { compact_summary: (event && event.summary) || '' });
  });
}
`;
}

interface PiMcpConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

async function readPiMcpConfig(): Promise<PiMcpConfig> {
  try {
    const raw = await fs.readFile(piMcpConfigPath(), 'utf8');
    const parsed = JSON.parse(raw) as PiMcpConfig;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (isEnoent(error)) return {};
    throw error;
  }
}

/**
 * Merge the memorize MCP server into ~/.pi/agent/mcp.json (Claude-format,
 * idempotent). pi has no first-party MCP — a community extension reads this
 * file — so this is additive: it lights up memorize's tools where such an
 * extension is present, and is harmless otherwise. Preserves other servers.
 */
async function mergePiMcpConfig(): Promise<string> {
  const config = await readPiMcpConfig();
  config.mcpServers = { ...(config.mcpServers ?? {}) };
  config.mcpServers[MEMORIZE_MCP_KEY] = {
    command: 'npx',
    args: ['-y', '@shakystar/memorize', 'mcp'],
  };
  const configPath = piMcpConfigPath();
  await writeJson(configPath, config);
  return configPath;
}

async function writePiExtension(): Promise<void> {
  const extPath = piExtensionPath();
  await fs.mkdir(path.dirname(extPath), { recursive: true });
  await fs.writeFile(extPath, renderPiExtension(tsPluginSpawnSpec()), 'utf8');
}

/**
 * Wire memorize into pi: plant the capture+inject extension (global), merge the
 * MCP block (global mcp.json), and plant the project's AGENTS.md ground-rule
 * block. Idempotent. Returns the extension path (pi's primary integration
 * surface) for the install summary.
 */
export async function installPiIntegration(cwd: string): Promise<string> {
  await writePiExtension();
  await mergePiMcpConfig();
  await upsertGroundRuleBlock(path.join(cwd, 'AGENTS.md'));
  return piExtensionPath();
}

/**
 * Reverse installPiIntegration: remove the extension file, drop the memorize
 * MCP entry, and strip the AGENTS.md ground-rule. Preserves other pi config and
 * never deletes user-owned AGENTS.md. Idempotent.
 */
export async function uninstallPiIntegration(cwd: string): Promise<string> {
  await fs.rm(piExtensionPath(), { force: true });
  const config = await readPiMcpConfig();
  if (config.mcpServers && MEMORIZE_MCP_KEY in config.mcpServers) {
    const servers = { ...config.mcpServers };
    delete servers[MEMORIZE_MCP_KEY];
    config.mcpServers = servers;
    await writeJson(piMcpConfigPath(), config);
  }
  await stripGroundRuleBlock(path.join(cwd, 'AGENTS.md'));
  return piExtensionPath();
}

// --- Hermes (yaml-shell-hooks mechanism) -------------------------------------

// Hermes (NousResearch/hermes-agent) integrates WITHOUT a planted plugin: its
// hooks are shell commands declared in ~/.hermes/config.yaml that Hermes runs as
// subprocesses, piping a JSON payload on stdin and reading stdout JSON back —
// exactly the contract `memorize hook <id> <event>` already speaks. So install
// touches three surfaces, ALL in the user-global ~/.hermes:
//   1. config.yaml `hooks` — three NATIVE events (pre_llm_call → session-start
//      injection, post_tool_call → capture, on_session_finalize → compaction
//      boundary), each pointing at `memorize hook hermes <event>`.
//   2. config.yaml `mcp_servers.memorize` — Hermes supports MCP natively in the
//      SAME file (additive; the pre_llm_call hook is what delivers session-start
//      memory, MCP just adds the recall/record/diagnose tool surface).
//   3. shell-hooks-allowlist.json — Hermes prompts for first-use approval of
//      each (event, command) pair. Running `memorize init` IS that consent, so
//      we pre-approve memorize's OWN commands (scoped — never the global
//      `hooks_auto_accept`, which would trust arbitrary third-party hooks). This
//      is what lets capture/injection work in non-interactive runs.
// Ground rule lands in AGENTS.md (Hermes reads it natively into the system
// prompt). Hooks are global, so like codex the runner bails when cwd is unbound.

const HERMES_HOOK_EVENTS = getHarness('hermes').hookEvents;

// pre_llm_call BLOCKS the turn waiting for injected context, so give it a
// generous bound; the other two are fire-and-forget observers (Hermes ignores
// their stdout) and return fast. Stays well under Hermes's 300s timeout cap.
const HERMES_HOOK_TIMEOUTS: Partial<Record<string, number>> = {
  pre_llm_call: 20,
};

function hermesConfigDir(): string {
  return path.join(os.homedir(), '.hermes');
}

function hermesConfigPath(): string {
  return path.join(hermesConfigDir(), 'config.yaml');
}

function hermesAllowlistPath(): string {
  return path.join(hermesConfigDir(), 'shell-hooks-allowlist.json');
}

/**
 * The exact command string for each hermes event, in the resolved form. Built
 * ONCE so config.yaml and the allowlist carry byte-identical strings — Hermes's
 * allowlist keys on the exact command text, so any drift would re-trigger the
 * approval prompt.
 */
function hermesHookCommands(): Record<string, string> {
  const form = detectHookCommandForm();
  const out: Record<string, string> = {};
  for (const event of HERMES_HOOK_EVENTS) {
    out[event] = buildHookCommand(form, 'hermes', event);
  }
  return out;
}

interface HermesHookEntry {
  command: string;
  matcher?: string;
  timeout?: number;
}

interface HermesConfig {
  hooks?: Record<string, HermesHookEntry[]>;
  mcp_servers?: Record<string, unknown>;
  [key: string]: unknown;
}

async function readHermesConfig(): Promise<HermesConfig> {
  try {
    const raw = await fs.readFile(hermesConfigPath(), 'utf8');
    const parsed = parseYaml(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as HermesConfig)
      : {};
  } catch (error) {
    if (isEnoent(error)) return {};
    throw error;
  }
}

/** Coerce a config.yaml hooks-event value to a clean entry array (defensive:
 *  a hand-edited file may hold a scalar/object/garbage under an event key). */
function coerceHermesEntries(raw: unknown): HermesHookEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e): HermesHookEntry | undefined => {
      if (e && typeof e === 'object' && typeof (e as HermesHookEntry).command === 'string') {
        return e as HermesHookEntry;
      }
      return undefined;
    })
    .filter((e): e is HermesHookEntry => e !== undefined);
}

/**
 * Merge memorize's hooks + MCP server into ~/.hermes/config.yaml (idempotent).
 * Per event: strip every prior memorize entry (any command form, so re-install
 * migrates npx↔node-abs cleanly), then append the current-form command —
 * preserving the user's own hook entries and all other config keys. NOTE: a
 * round-trip through `yaml` preserves data but not comments/anchors (same
 * tradeoff as the JSON config writers).
 */
async function mergeHermesConfig(commands: Record<string, string>): Promise<string> {
  const config = await readHermesConfig();
  const hooks: Record<string, HermesHookEntry[]> = {};
  for (const [event, value] of Object.entries(config.hooks ?? {})) {
    hooks[event] = coerceHermesEntries(value);
  }
  for (const event of HERMES_HOOK_EVENTS) {
    const others = (hooks[event] ?? []).filter(
      (e) => !isMemorizeHookCommandFor(e.command, 'hermes', event),
    );
    const timeout = HERMES_HOOK_TIMEOUTS[event];
    const entry: HermesHookEntry = {
      command: commands[event]!,
      ...(timeout !== undefined ? { timeout } : {}),
    };
    hooks[event] = [...others, entry];
  }
  config.hooks = hooks;

  config.mcp_servers = { ...(config.mcp_servers ?? {}) };
  config.mcp_servers[MEMORIZE_MCP_KEY] = {
    command: 'npx',
    args: ['-y', '@shakystar/memorize', 'mcp'],
    enabled: true,
  };

  const configPath = hermesConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, stringifyYaml(config), 'utf8');
  return configPath;
}

interface HermesAllowlist {
  approvals?: Array<{ event?: string; command?: string }>;
  [key: string]: unknown;
}

async function readHermesAllowlist(): Promise<HermesAllowlist> {
  try {
    const raw = await fs.readFile(hermesAllowlistPath(), 'utf8');
    const parsed = JSON.parse(raw) as HermesAllowlist;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (isEnoent(error)) return {};
    throw error;
  }
}

/**
 * Pre-approve memorize's own (event, command) pairs in
 * ~/.hermes/shell-hooks-allowlist.json so capture/injection work without the
 * interactive first-use prompt. Strips any stale memorize approval (different
 * command form) first, then adds the current ones — preserving the user's and
 * other tools' approvals. Scoped to memorize's commands ONLY; never sets the
 * global `hooks_auto_accept`.
 */
async function mergeHermesAllowlist(
  commands: Record<string, string>,
): Promise<void> {
  const allowlist = await readHermesAllowlist();
  const existing = Array.isArray(allowlist.approvals) ? allowlist.approvals : [];
  // Drop ALL memorize-hermes approvals (any form/event), then re-add current.
  const others = existing.filter(
    (a) =>
      typeof a.command !== 'string' ||
      !isMemorizeHookCommandForAgent(a.command, 'hermes'),
  );
  const ours = HERMES_HOOK_EVENTS.map((event) => ({
    event,
    command: commands[event]!,
  }));
  allowlist.approvals = [...others, ...ours];
  const allowlistPath = hermesAllowlistPath();
  await fs.mkdir(path.dirname(allowlistPath), { recursive: true });
  await writeJson(allowlistPath, allowlist);
}

/**
 * Wire memorize into Hermes: merge hooks + MCP into ~/.hermes/config.yaml,
 * pre-approve memorize's commands in the shell-hooks allowlist, and plant the
 * project's AGENTS.md ground-rule block. Idempotent. Returns the config.yaml
 * path (the primary integration surface) for the install summary.
 */
export async function installHermesIntegration(cwd: string): Promise<string> {
  const commands = hermesHookCommands();
  const configPath = await mergeHermesConfig(commands);
  await mergeHermesAllowlist(commands);
  await upsertGroundRuleBlock(path.join(cwd, 'AGENTS.md'));
  return configPath;
}

/**
 * Reverse installHermesIntegration: strip memorize hook entries from
 * config.yaml (dropping events left empty) + the memorize MCP server, remove
 * memorize's allowlist approvals, and strip the AGENTS.md ground-rule. Preserves
 * the user's other config/approvals and never deletes user-owned AGENTS.md.
 * Idempotent.
 */
export async function uninstallHermesIntegration(cwd: string): Promise<string> {
  const configPath = hermesConfigPath();
  const config = await readHermesConfig();
  let configChanged = false;

  if (config.hooks && typeof config.hooks === 'object') {
    const hooks: Record<string, HermesHookEntry[]> = {};
    for (const [event, value] of Object.entries(config.hooks)) {
      const kept = coerceHermesEntries(value).filter(
        (e) => !isMemorizeHookCommandForAgent(e.command, 'hermes'),
      );
      if (kept.length > 0) hooks[event] = kept;
    }
    config.hooks = hooks;
    configChanged = true;
  }
  if (config.mcp_servers && MEMORIZE_MCP_KEY in config.mcp_servers) {
    const servers = { ...config.mcp_servers };
    delete servers[MEMORIZE_MCP_KEY];
    config.mcp_servers = servers;
    configChanged = true;
  }
  if (configChanged) {
    try {
      await fs.writeFile(configPath, stringifyYaml(config), 'utf8');
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }

  const allowlist = await readHermesAllowlist();
  if (Array.isArray(allowlist.approvals)) {
    allowlist.approvals = allowlist.approvals.filter(
      (a) =>
        typeof a.command !== 'string' ||
        !isMemorizeHookCommandForAgent(a.command, 'hermes'),
    );
    try {
      await writeJson(hermesAllowlistPath(), allowlist);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }

  await stripGroundRuleBlock(path.join(cwd, 'AGENTS.md'));
  return configPath;
}
