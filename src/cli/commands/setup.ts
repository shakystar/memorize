import {
  defaultDetectDeps,
  detectAgents,
} from '../../services/agent-detect.js';
import {
  installCodexHooks,
  installInitMemorizeSkill,
} from '../../services/install-service.js';
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
    // Claude hooks are per-project, so setup can't wire them globally. Instead
    // plant a global skill so any project gains a "set up memorize here" →
    // `memorize init` trigger — that's the one command that does the wiring.
    await installInitMemorizeSkill();
    lines.push('OK  Claude Code detected. Planted the global `init-memorize`');
    lines.push('    skill — in any project, ask me to "set up memorize" and');
    lines.push('    I will run `memorize init` (or run it yourself).');
  }

  lines.push('');
  lines.push('Next: use `claude` / `codex` as usual — context loads at session start.');
  console.log(lines.join('\n'));
}
