import {
  defaultDetectDeps,
  detectAgents,
} from '../../services/agent-detect.js';
import { installCodexHooks } from '../../services/install-service.js';
import type { CliContext } from '../context.js';

export async function runSetupCommand(
  _args: string[],
  _ctx: CliContext,
): Promise<void> {
  const detection = detectAgents(defaultDetectDeps());

  if (!detection.claude.present && !detection.codex.present) {
    console.log(
      [
        'Memorize installed. No supported AI agent detected yet.',
        '',
        'Install Claude Code or Codex, then re-run `memorize setup`.',
        'Or wire one manually:',
        '  memorize install codex     (global)',
        '  memorize install claude    (run inside a project)',
      ].join('\n'),
    );
    return;
  }

  const lines: string[] = ['Memorize installed.', ''];

  if (detection.codex.present) {
    const hooksPath = await installCodexHooks();
    lines.push(`OK  Codex wired globally: ${hooksPath}`);
  }

  if (detection.claude.present) {
    lines.push('--  Claude Code detected. Its hooks are per-project, so run');
    lines.push('    this inside each project you want memorize in:');
    lines.push('      memorize install claude');
  }

  lines.push('');
  lines.push('Next: use `claude` / `codex` as usual — context loads at session start.');
  console.log(lines.join('\n'));
}
