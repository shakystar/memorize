// Gemini CLI renders Markdown in its context window like codex/opencode, so the
// codex renderer's section layout is reused verbatim until the formats need to
// diverge. Dedicated module so a gemini-specific layout has a home later.
export {
  renderCodexStartupContext as renderGeminiStartupContext,
  renderCodexLiveUpdate as renderGeminiLiveUpdate,
} from '../codex/renderer.js';
