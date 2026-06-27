import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import which from 'which';

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
  agent: 'claude' | 'codex',
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
  '(?:(?:@shakystar/)?memorize\\s+hook|memorize[^"\\s]*[/\\\\]cli[/\\\\]index\\.js"?\\s+hook)';

/**
 * Matches any historical or current memorize hook command shape so
 * re-installing migrates from one form to another (e.g. swap npx for
 * bare/node-abs when memorize lands on PATH, or strip a removed event
 * like Stop) without leaving duplicates.
 */
function isMemorizeHookCommandFor(
  command: string,
  agent: 'claude' | 'codex',
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
  agent: 'claude' | 'codex',
): boolean {
  const re = new RegExp(`${MEMORIZE_TOKEN}\\s+${agent}\\b`);
  return re.test(command);
}

// Hook events the β contract registers for Claude. Stop is intentionally
// absent — see hook-service.ts for the rationale (Stop fires per-turn,
// not per-session, and lifecycle moved to SessionEnd + reapStaleSessions).
// PreCompact is gone too (#85): its checkpoint-capture role was replaced
// wholesale by the PostCompact consolidation boundary, the handler had
// been a no-op for a while, and real stores show ZERO checkpoint events —
// registering it only spawned a useless subprocess on every compaction.
// PostToolUse (CLS capture) carries a tool matcher so the hook subprocess
// only spawns for tools the decision-signal filter could ever admit.
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'PostCompact',
  'SessionEnd',
  'PostToolUse',
] as const;

// Per-event matcher for Claude hook registration. PostToolUse fires for
// every tool; matching here (instead of in the handler) saves a subprocess
// spawn per read-only tool call. The matcher is DERIVED from
// capture-service's whitelist (single source — decision ③), so the hook
// registration can never drift from the filter.
const CLAUDE_HOOK_MATCHERS: Partial<Record<string, string>> = {
  PostToolUse: POST_TOOL_USE_MATCHER,
};

// Memorize hook events that previous installs may have registered but
// the current β contract no longer wants. We strip these from the
// merged settings on re-install. Keep narrow — only memorize-owned
// entries; user-added entries for other tools under the same event
// keys must be untouched.
const CLAUDE_LEGACY_MEMORIZE_HOOK_EVENTS = ['Stop', 'PreCompact'] as const;

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
  agent: 'claude' | 'codex',
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

export async function installClaudeIntegration(cwd: string): Promise<string> {
  const settingsPath = path.join(cwd, '.claude', 'settings.local.json');
  let settings: { hooks?: Record<string, unknown> } = {};
  try {
    settings = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as {
      hooks?: Record<string, unknown>;
    };
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
  }

  const rawHooks = settings.hooks ?? {};
  const migrated: HooksMap = {};
  for (const [event, value] of Object.entries(rawHooks)) {
    const groups = coerceLegacyList(value);
    if (groups) migrated[event] = groups;
  }

  const form = detectHookCommandForm();
  const purged: HooksMap = { ...migrated };

  // Strip every existing memorize entry (both active and legacy events,
  // both npx and bare forms) so the rebuild below leaves exactly the
  // β-contract entries with the freshly resolved command form.
  const allEvents = [...CLAUDE_HOOK_EVENTS, ...CLAUDE_LEGACY_MEMORIZE_HOOK_EVENTS];
  for (const event of allEvents) {
    const cleaned = stripMemorizeForEvent(purged[event], 'claude', event);
    if (cleaned) {
      purged[event] = cleaned;
    } else {
      delete purged[event];
    }
  }

  // Re-add memorize entries for the active events only.
  const rebuilt: HooksMap = { ...purged };
  for (const event of CLAUDE_HOOK_EVENTS) {
    rebuilt[event] = ensureMemorizeCommand(
      purged[event],
      buildHookCommand(form, 'claude', event),
      CLAUDE_HOOK_MATCHERS[event] ?? '',
    );
  }

  const merged = {
    ...settings,
    hooks: rebuilt,
  };

  await writeJson(settingsPath, merged);
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

// Codex hook events the β contract registers. Codex has no SessionEnd /
// Shutdown / Exit hook (verified against developers.openai.com/codex/hooks
// 2026-05), so codex session lifecycle is owned by reapStaleSessions, and
// the CLS consolidation boundary is PostCompact + the next SessionStart's
// catch-up. PostToolUse is registered even though codex currently fires it
// for Bash-like tools only — partial capture beats none, and coverage
// widens automatically if the upstream issue is fixed.
const CODEX_HOOK_EVENTS = ['SessionStart', 'PostToolUse', 'PostCompact'] as const;

// Codex Stop fires per-turn just like Claude's, so the rc.X
// auto-handoff path was wrong here too. Strip the legacy registration
// on re-install.
const CODEX_LEGACY_MEMORIZE_HOOK_EVENTS = ['Stop'] as const;

function codexHooksPath(): string {
  return path.join(os.homedir(), '.codex', 'hooks.json');
}

export async function installCodexHooks(): Promise<string> {
  const hooksPath = codexHooksPath();

  let settings: { hooks?: Record<string, unknown> } = {};
  try {
    settings = JSON.parse(await fs.readFile(hooksPath, 'utf8')) as {
      hooks?: Record<string, unknown>;
    };
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }

  const rawHooks = settings.hooks ?? {};
  const migrated: HooksMap = {};
  for (const [event, value] of Object.entries(rawHooks)) {
    const groups = coerceLegacyList(value);
    if (groups) migrated[event] = groups;
  }

  const form = detectHookCommandForm();
  const purged: HooksMap = { ...migrated };

  // Strip every existing memorize entry so the rebuild leaves exactly
  // the β-contract entries with the freshly resolved command form.
  const allEvents = [...CODEX_HOOK_EVENTS, ...CODEX_LEGACY_MEMORIZE_HOOK_EVENTS];
  for (const event of allEvents) {
    const cleaned = stripMemorizeForEvent(purged[event], 'codex', event);
    if (cleaned) {
      purged[event] = cleaned;
    } else {
      delete purged[event];
    }
  }

  // Prepend memorize entries so our context is established before any
  // other layer (OMX, third-party) runs.
  const prependMemorize = (
    list: HookMatcherGroup[] | undefined,
    command: string,
    matcher?: string,
  ): HookMatcherGroup[] => {
    const current = list ?? [];
    if (
      current.some((group) =>
        group.hooks.some((entry) => entry.command === command),
      )
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
  };

  const rebuilt: HooksMap = { ...purged };
  for (const event of CODEX_HOOK_EVENTS) {
    // Codex SessionStart wants matcher 'startup|resume'; if we add new
    // codex events later, we'll thread per-event matcher choice here.
    const matcher = event === 'SessionStart' ? 'startup|resume' : undefined;
    rebuilt[event] = prependMemorize(
      purged[event],
      buildHookCommand(form, 'codex', event),
      matcher,
    );
  }

  const merged = {
    ...settings,
    hooks: rebuilt,
  };

  await writeJson(hooksPath, merged);
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
  agent: 'claude' | 'codex',
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
