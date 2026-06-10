import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

function buildHookCommand(
  form: HookCommandForm,
  agent: 'claude' | 'codex',
  event: string,
): string {
  return form === 'bare'
    ? `memorize hook ${agent} ${event}`
    : `npx @shakystar/memorize hook ${agent} ${event}`;
}

/**
 * Matches any historical or current memorize hook command shape so
 * re-installing migrates from one form to another (e.g. swap npx for
 * bare when memorize lands on PATH, or strip a removed event like
 * Stop) without leaving duplicates.
 */
function isMemorizeHookCommandFor(
  command: string,
  agent: 'claude' | 'codex',
  event: string,
): boolean {
  const re = new RegExp(
    `(@shakystar/)?memorize\\s+hook\\s+${agent}\\s+${event}\\b`,
  );
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
const CLAUDE_HOOK_EVENTS = [
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
  return settingsPath;
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
