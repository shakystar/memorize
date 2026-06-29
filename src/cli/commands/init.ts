import { getHarness } from '../../harness/registry.js';
import { onboardProject } from '../../services/onboarding-service.js';
import type { CliContext } from '../context.js';
import { parseFlags } from '../parse-flags.js';
import { codexPostInstallNotice } from './install.js';

/**
 * `memorize init` — one-shot onboarding for the current directory. Replaces the
 * multi-step flow (`project init` + `project setup` + `install <agent>`) with a
 * single idempotent command: bind/adopt the project, import context, detect
 * installed harnesses, and wire each present one. The lower-level commands
 * remain as escape hatches. Registry-driven — new harnesses surface here
 * automatically via onboardProject's `wired` list.
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

  for (const w of result.wired) {
    const scope = getHarness(w.id).hookScope === 'global' ? 'global' : 'per-project';
    lines.push(`OK  ${w.label} wired (${scope}): ${w.configPath}`);
  }

  if (result.wired.length === 0) {
    // The project bind + import still succeeded — this is guidance, not an error.
    lines.push(
      '',
      'No supported AI agent detected yet.',
      'Install one, then re-run `memorize init`. Or wire one manually:',
      '  memorize install codex     (global)',
      '  memorize install claude    (run inside a project)',
    );
  }

  for (const warning of result.warnings) {
    lines.push('', `⚠️  ${warning}`);
  }

  const wiredIds = new Set(result.wired.map((w) => w.id));
  if (wiredIds.has('codex')) {
    lines.push(...codexPostInstallNotice());
  }
  if (wiredIds.has('opencode')) {
    lines.push(
      '',
      'opencode: restart opencode to load the memorize plugin and MCP server.',
      'Session-start memory is served via the `memorize_context` MCP tool',
      '(opencode has no session-start hook); auto-capture runs via the plugin.',
    );
  }
  if (wiredIds.has('pi')) {
    lines.push(
      '',
      'pi: restart pi to load the memorize extension (~/.pi/agent/extensions/).',
      'Session-start memory injects via the before_agent_start hook; auto-capture',
      'runs on tool_result. (pi reads AGENTS.md natively for the ground rule.)',
    );
  }
  if (wiredIds.has('hermes')) {
    lines.push(
      '',
      'Hermes: hooks were written to ~/.hermes/config.yaml and memorize’s own',
      'commands pre-approved in ~/.hermes/shell-hooks-allowlist.json, so capture',
      'and session-start injection work on the next `hermes` run. Session-start',
      'memory injects via the pre_llm_call hook (once per session); auto-capture',
      'runs on post_tool_call. (Hermes reads AGENTS.md natively for the ground rule.)',
    );
  }
  if (wiredIds.has('cursor')) {
    lines.push(
      '',
      'Cursor: hooks were written to .cursor/hooks.json and the memorize MCP',
      'server to .cursor/mcp.json (both per-project) — restart Cursor to load them.',
      'Session-start memory injects via the sessionStart hook; auto-capture runs',
      'on postToolUse. (Cursor reads AGENTS.md natively for the ground rule.)',
    );
  }

  lines.push(
    '',
    'Next: use your agent as usual — context loads at session start.',
  );

  console.log(lines.join('\n'));
}
