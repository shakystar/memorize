import fs from 'node:fs/promises';
import path from 'node:path';

const CLAUDE_HOOK_COMMANDS = {
  SessionStart: 'memorize hook claude SessionStart',
  PreCompact: 'memorize hook claude PreCompact',
  PostCompact: 'memorize hook claude PostCompact',
  Stop: 'memorize hook claude Stop',
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
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
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

export async function installCodexIntegration(cwd: string): Promise<string> {
  const overridePath = path.join(cwd, 'AGENTS.override.md');
  const content = [
    '# Memorize-managed bootstrap guidance',
    '',
    '- Prefer launching Codex via `memorize launch codex` for shared context bootstrap.',
    '- Memorize will generate and refresh bootstrap context under `.memorize/bootstrap/`.',
    '- Keep AGENTS override short; treat Memorize as the source for launch-time context injection.',
  ].join('\n');

  let existing = '';
  try {
    existing = await fs.readFile(overridePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const startMarker = '<!-- Memorize:START -->';
  const endMarker = '<!-- Memorize:END -->';
  const managedBlock = `${startMarker}\n${content}\n${endMarker}`;

  let next = existing;
  const startIndex = existing.indexOf(startMarker);
  const endIndex = existing.indexOf(endMarker);
  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    next =
      existing.slice(0, startIndex).trimEnd() +
      '\n\n' +
      managedBlock +
      '\n';
  } else if (existing.trim().length > 0) {
    next = `${existing.trimEnd()}\n\n${managedBlock}\n`;
  } else {
    next = `${managedBlock}\n`;
  }

  await fs.writeFile(overridePath, next, 'utf8');
  return overridePath;
}
