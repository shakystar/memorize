export function renderScaffoldUsage(): string {
  return [
    'Memorize — shared project memory for human + AI collaboration',
    '',
    'Day-to-day:',
    '  memorize doctor              Diagnose project and integration state',
    '  memorize project show        Print bound project summary (JSON)',
    '  memorize task list           List tasks in the current project',
    '  memorize task resume         Load startup context for the current task',
    '  memorize task handoff ...    Record a handoff to the next agent',
    '',
    'Setup (usually run by the AI assistant):',
    '  memorize project setup       Bind cwd + import AGENTS.md / CLAUDE.md / rules',
    '  memorize install claude      Wire Memorize into .claude/settings.local.json',
    '  memorize install codex       Wire Memorize bootstrap into AGENTS.override.md',
    '',
    'Full reference (every command, flags, and failure modes):',
    '  https://github.com/shakystar/memorize/blob/main/AGENT_GUIDE.md',
    '',
    'Tip: run `memorize <command> --help` or see the link above for details.',
  ].join('\n');
}
