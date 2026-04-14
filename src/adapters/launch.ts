import path from 'node:path';

export function resolveLaunchCommand(agent: 'claude' | 'codex'): string {
  const envName = agent === 'claude' ? 'MEMORIZE_CLAUDE_BIN' : 'MEMORIZE_CODEX_BIN';
  return process.env[envName] || agent;
}

export function codexLastMessagePath(cwd: string): string {
  return path.join(cwd, '.memorize', 'bootstrap', 'codex-last-message.txt');
}

export function buildLaunchArgs(params: {
  agent: 'claude' | 'codex';
  startupContext: string;
  passthroughArgs: string[];
  cwd: string;
}): string[] {
  if (params.agent === 'claude') {
    return [
      '--append-system-prompt',
      params.startupContext,
      ...params.passthroughArgs,
    ];
  }

  const passthrough = [...params.passthroughArgs];
  if (
    passthrough[0] === 'exec' &&
    !passthrough.includes('--output-last-message')
  ) {
    passthrough.push('--output-last-message', codexLastMessagePath(params.cwd));
  }

  return [params.startupContext, ...passthrough];
}
