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
  Stop: 'npx @shakystar/memorize hook claude Stop',
} as const;

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

  const merged = {
    ...settings,
    hooks: {
      ...migrated,
      SessionStart: ensureMemorizeCommand(
        migrated.SessionStart,
        CLAUDE_HOOK_COMMANDS.SessionStart,
      ),
      PreCompact: ensureMemorizeCommand(
        migrated.PreCompact,
        CLAUDE_HOOK_COMMANDS.PreCompact,
      ),
      PostCompact: ensureMemorizeCommand(
        migrated.PostCompact,
        CLAUDE_HOOK_COMMANDS.PostCompact,
      ),
      Stop: ensureMemorizeCommand(migrated.Stop, CLAUDE_HOOK_COMMANDS.Stop),
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
  Stop: 'npx @shakystar/memorize hook codex Stop',
} as const;

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
      ...migrated,
      SessionStart: prependMemorize(
        migrated.SessionStart,
        CODEX_HOOK_COMMANDS.SessionStart,
        'startup|resume',
      ),
      Stop: prependMemorize(migrated.Stop, CODEX_HOOK_COMMANDS.Stop),
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

export async function installCodexIntegration(cwd: string): Promise<string> {
  const hooksPath = await installCodexHooks();

  const overridePath = path.join(cwd, 'AGENTS.override.md');
  try {
    const existing = await fs.readFile(overridePath, 'utf8');
    const cleaned = stripLegacyMemorizeBlock(existing);
    if (cleaned !== existing) {
      if (cleaned.trim().length === 0) {
        await fs.unlink(overridePath);
      } else {
        await fs.writeFile(overridePath, cleaned, 'utf8');
      }
    }
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }

  return hooksPath;
}
