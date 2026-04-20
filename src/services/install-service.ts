import fs from 'node:fs/promises';
import path from 'node:path';

import { isEnoent } from '../storage/fs-utils.js';

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

function ensureHookCommand(
  list: Array<{ command: string }> | undefined,
  command: string,
): Array<{ command: string }> {
  const current = list ?? [];
  return current.some((entry) => entry.command === command)
    ? current
    : [...current, { command }];
}

export async function installClaudeIntegration(cwd: string): Promise<string> {
  const claudeDir = path.join(cwd, '.claude');
  await fs.mkdir(claudeDir, { recursive: true });

  const settingsPath = path.join(claudeDir, 'settings.local.json');
  let settings: { hooks?: Record<string, Array<{ command: string }>> } = {};
  try {
    settings = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as {
      hooks?: Record<string, Array<{ command: string }>>;
    };
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
  }

  const hooks = settings.hooks ?? {};
  const merged = {
    ...settings,
    hooks: {
      ...hooks,
      SessionStart: ensureHookCommand(
        hooks.SessionStart,
        CLAUDE_HOOK_COMMANDS.SessionStart,
      ),
      PreCompact: ensureHookCommand(
        hooks.PreCompact,
        CLAUDE_HOOK_COMMANDS.PreCompact,
      ),
      PostCompact: ensureHookCommand(
        hooks.PostCompact,
        CLAUDE_HOOK_COMMANDS.PostCompact,
      ),
      Stop: ensureHookCommand(hooks.Stop, CLAUDE_HOOK_COMMANDS.Stop),
    },
  };

  await fs.writeFile(settingsPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return settingsPath;
}

const CODEX_START_MARKER = '<!-- memorize:bootstrap v=1 start -->';
const CODEX_END_MARKER = '<!-- memorize:bootstrap v=1 end -->';
const LEGACY_CODEX_START_MARKER = '<!-- Memorize:START -->';
const LEGACY_CODEX_END_MARKER = '<!-- Memorize:END -->';

const CODEX_BLOCK_BODY = [
  '# Memorize-managed bootstrap guidance',
  '',
  '- At the start of every session, run `npx @shakystar/memorize task resume` and treat the JSON it prints as the authoritative project context.',
  '- Before ending a session, run `npx @shakystar/memorize task handoff --summary "..." --next "..."` so the next agent (human or AI) can pick up without re-explaining.',
  '- Treat Memorize as the source of truth for tasks, decisions, and cross-session memory. Do not invent state; ask Memorize.',
] as const;

function assertCodexBodySafe(): void {
  for (const line of CODEX_BLOCK_BODY) {
    if (
      line.includes(CODEX_START_MARKER) ||
      line.includes(CODEX_END_MARKER) ||
      line.includes(LEGACY_CODEX_START_MARKER) ||
      line.includes(LEGACY_CODEX_END_MARKER)
    ) {
      throw new Error(
        'Codex bootstrap body contains a marker sentinel; aborting to protect file integrity.',
      );
    }
  }
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

function renderWithBlock(
  base: string,
  managedBlock: string,
): string {
  const trimmed = base.trim();
  if (trimmed.length === 0) {
    return `${managedBlock}\n`;
  }
  return `${trimmed}\n\n${managedBlock}\n`;
}

function upsertCodexBlock(existing: string, managedBlock: string): string {
  const withoutLegacy = stripLegacyBlock(existing);
  const bounds = locateBlock(withoutLegacy, CODEX_START_MARKER, CODEX_END_MARKER);

  if (!bounds) {
    return renderWithBlock(withoutLegacy, managedBlock);
  }

  const before = withoutLegacy.slice(0, bounds.startIndex).trimEnd();
  const after = withoutLegacy.slice(bounds.afterEndIndex).replace(/^\n+/, '');

  const parts: string[] = [];
  if (before.length > 0) {
    parts.push(before, '');
  }
  parts.push(managedBlock);
  if (after.length > 0) {
    parts.push('', after.trimEnd());
  }
  return `${parts.join('\n')}\n`;
}

export async function installCodexIntegration(cwd: string): Promise<string> {
  assertCodexBodySafe();

  const overridePath = path.join(cwd, 'AGENTS.override.md');
  const managedBlock = [
    CODEX_START_MARKER,
    ...CODEX_BLOCK_BODY,
    CODEX_END_MARKER,
  ].join('\n');

  let existing = '';
  try {
    existing = await fs.readFile(overridePath, 'utf8');
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
  }

  const next = upsertCodexBlock(existing, managedBlock);
  await fs.writeFile(overridePath, next, 'utf8');
  return overridePath;
}
