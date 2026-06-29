import type { HarnessId } from '../harness/registry.js';
import {
  renderClaudeLiveUpdate,
  renderClaudeStartupContext,
} from './claude/renderer.js';
import {
  renderCodexLiveUpdate,
  renderCodexStartupContext,
} from './codex/renderer.js';
import {
  renderOpencodeLiveUpdate,
  renderOpencodeStartupContext,
} from './opencode/renderer.js';
import {
  renderGeminiLiveUpdate,
  renderGeminiStartupContext,
} from './gemini/renderer.js';
import type { AdapterRuntime } from './types.js';

/** @deprecated alias of {@link HarnessId} — kept for existing call sites. */
export type AdapterAgent = HarnessId;

export const adapterRegistry: Record<AdapterAgent, AdapterRuntime> = {
  claude: {
    name: 'claude',
    renderStartupContext: renderClaudeStartupContext,
    renderLiveUpdate: renderClaudeLiveUpdate,
  },
  codex: {
    name: 'codex',
    renderStartupContext: renderCodexStartupContext,
    renderLiveUpdate: renderCodexLiveUpdate,
  },
  opencode: {
    name: 'opencode',
    renderStartupContext: renderOpencodeStartupContext,
    renderLiveUpdate: renderOpencodeLiveUpdate,
  },
  gemini: {
    name: 'gemini',
    renderStartupContext: renderGeminiStartupContext,
    renderLiveUpdate: renderGeminiLiveUpdate,
  },
};
