import { onboardProject } from '../../services/onboarding-service.js';
import type { CliContext } from '../context.js';
import { parseFlags } from '../parse-flags.js';
import { codexPostInstallNotice } from './install.js';

/**
 * `memorize init` — one-shot onboarding for the current directory. Replaces the
 * four-step flow (`project init` + `project setup` + `install claude` +
 * `install codex`) with a single idempotent command: bind/adopt the project,
 * import context, detect installed agents, and wire each present agent. The
 * lower-level commands remain as escape hatches.
 *
 * `--nested` (alias `--force`): when cwd sits inside an already-bound ancestor,
 * create a SEPARATE nested project here instead of refusing.
 */
export async function runInitCommand(
  args: string[],
  ctx: CliContext,
): Promise<void> {
  const flags = parseFlags(args, { boolean: ['nested', 'force'] });
  const nested = flags.boolean.nested === true || flags.boolean.force === true;

  const result = await onboardProject(ctx.cwd, { nested });

  const verb = result.relocated
    ? 'Relocated existing project'
    : result.nested
      ? 'Initialized nested project'
      : 'Initialized project';

  const lines: string[] = [
    `${verb} ${result.project.title} (${result.project.id})`,
    `Imported context files: ${result.importedContextCount}`,
  ];

  if (result.wiredClaude) {
    lines.push(
      `OK  Claude Code wired (per-project): ${result.claudeSettingsPath}`,
    );
  }
  if (result.wiredCodex) {
    lines.push(`OK  Codex wired (global): ${result.codexHooksPath}`);
  }

  if (!result.wiredClaude && !result.wiredCodex) {
    // The project bind + import still succeeded — this is guidance, not an error.
    lines.push(
      '',
      'No supported AI agent detected yet (no Claude Code or Codex found).',
      'Install one, then re-run `memorize init`. Or wire one manually:',
      '  memorize install codex     (global)',
      '  memorize install claude    (run inside a project)',
    );
  }

  for (const warning of result.warnings) {
    lines.push('', `⚠️  ${warning}`);
  }

  if (result.wiredCodex) {
    lines.push(...codexPostInstallNotice());
  }

  lines.push(
    '',
    'Next: use `claude` / `codex` as usual — context loads at session start.',
  );

  console.log(lines.join('\n'));
}
