import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isEnoent, writeJson } from '../storage/fs-utils.js';

// Using `npx @shakystar/memorize ...` (scoped, fully qualified) rather
// than bare `memorize ...` so hooks work regardless of install mode:
// - local dev dep: npx resolves node_modules/.bin without a fetch
// - global install: npx finds the global bin
// - no install yet / non-Node project: npx fetches from the registry
//   on first call and caches, subsequent runs are fast.
// A bare `memorize` in the hook command would break in any environment
// where memorize is not already on PATH (including most non-Node repos).
const CLAUDE_HOOK_COMMANDS = {
  SessionStart: 'npx @shakystar/memorize hook claude SessionStart',
  PreCompact: 'npx @shakystar/memorize hook claude PreCompact',
  PostCompact: 'npx @shakystar/memorize hook claude PostCompact',
  SessionEnd: 'npx @shakystar/memorize hook claude SessionEnd',
} as const;

// Hook commands previous installs registered for memorize that the
// current β-track design no longer wants. We strip these from the
// merged settings so re-running `install claude` migrates an existing
// project off the per-turn auto-handoff path. Keep the list narrow —
// only memorize-owned commands; user-added Stop hooks for other tools
// must be untouched.
const CLAUDE_LEGACY_MEMORIZE_HOOK_COMMANDS = [
  'npx @shakystar/memorize hook claude Stop',
] as const;

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

function hookGroupHasCommand(group: HookMatcherGroup, command: string): boolean {
  return (
    (group.matcher ?? '') === '' &&
    group.hooks.some((entry) => entry.command === command)
  );
}

function ensureMemorizeCommand(
  list: HookMatcherGroup[] | undefined,
  command: string,
): HookMatcherGroup[] {
  const current = list ?? [];
  if (current.some((group) => hookGroupHasCommand(group, command))) {
    return current;
  }
  return [
    ...current,
    {
      matcher: '',
      hooks: [{ type: 'command', command }],
    },
  ];
}

/**
 * Strip a memorize-owned hook command from a matcher-group list,
 * preserving any other entries the user may have added under the same
 * event. Returns undefined when removing our entry leaves the event
 * with no groups, so the caller can drop the event key entirely.
 */
function stripMemorizeCommand(
  list: HookMatcherGroup[] | undefined,
  command: string,
): HookMatcherGroup[] | undefined {
  if (!list) return undefined;
  const cleaned = list
    .map((group) => ({
      ...group,
      hooks: group.hooks.filter((entry) => entry.command !== command),
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

  // Strip legacy memorize-owned hook commands first so the merged
  // result reflects only the current β contract. Anything user-added
  // under the same event keys stays put.
  const purged: HooksMap = { ...migrated };
  for (const legacyCommand of CLAUDE_LEGACY_MEMORIZE_HOOK_COMMANDS) {
    for (const event of Object.keys(purged)) {
      const cleaned = stripMemorizeCommand(purged[event], legacyCommand);
      if (cleaned) {
        purged[event] = cleaned;
      } else {
        delete purged[event];
      }
    }
  }

  const merged = {
    ...settings,
    hooks: {
      ...purged,
      SessionStart: ensureMemorizeCommand(
        purged.SessionStart,
        CLAUDE_HOOK_COMMANDS.SessionStart,
      ),
      PreCompact: ensureMemorizeCommand(
        purged.PreCompact,
        CLAUDE_HOOK_COMMANDS.PreCompact,
      ),
      PostCompact: ensureMemorizeCommand(
        purged.PostCompact,
        CLAUDE_HOOK_COMMANDS.PostCompact,
      ),
      SessionEnd: ensureMemorizeCommand(
        purged.SessionEnd,
        CLAUDE_HOOK_COMMANDS.SessionEnd,
      ),
    },
  };

  await writeJson(settingsPath, merged);
  return settingsPath;
}

const CODEX_START_MARKER = '<!-- memorize:bootstrap v=1 start -->';
const CODEX_END_MARKER = '<!-- memorize:bootstrap v=1 end -->';
const LEGACY_CODEX_START_MARKER = '<!-- Memorize:START -->';
const LEGACY_CODEX_END_MARKER = '<!-- Memorize:END -->';

const CODEX_HOOK_COMMANDS = {
  SessionStart: 'npx @shakystar/memorize hook codex SessionStart',
} as const;

// Codex has no SessionEnd / Shutdown / Exit hook of any kind (verified
// against developers.openai.com/codex/hooks 2026-05). Codex Stop fires
// per-turn just like Claude's, so the rc.X auto-handoff path was wrong
// here too. Strip the legacy registration on re-install; lifecycle for
// codex is owned entirely by reapStaleSessions.
const CODEX_LEGACY_MEMORIZE_HOOK_COMMANDS = [
  'npx @shakystar/memorize hook codex Stop',
] as const;

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

  // Drop legacy memorize-owned commands the β contract no longer
  // wants. Same care as Claude install: only memorize-prefixed
  // entries are removed.
  const purged: HooksMap = { ...migrated };
  for (const legacyCommand of CODEX_LEGACY_MEMORIZE_HOOK_COMMANDS) {
    for (const event of Object.keys(purged)) {
      const cleaned = stripMemorizeCommand(purged[event], legacyCommand);
      if (cleaned) {
        purged[event] = cleaned;
      } else {
        delete purged[event];
      }
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

  const merged = {
    ...settings,
    hooks: {
      ...purged,
      SessionStart: prependMemorize(
        purged.SessionStart,
        CODEX_HOOK_COMMANDS.SessionStart,
        'startup|resume',
      ),
    },
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

  return hooksPath;
}
