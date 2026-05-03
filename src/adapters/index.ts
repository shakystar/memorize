import { renderClaudeStartupContext } from './claude/renderer.js';
import { renderCodexStartupContext } from './codex/renderer.js';
import type { AdapterRuntime } from './types.js';

export type AdapterAgent = 'claude' | 'codex';

export const adapterRegistry: Record<AdapterAgent, AdapterRuntime> = {
  claude: {
    name: 'claude',
    renderStartupContext: renderClaudeStartupContext,
  },
  codex: {
    name: 'codex',
    renderStartupContext: renderCodexStartupContext,
  },
};
