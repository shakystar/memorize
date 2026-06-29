// Hermes injects context as plain text prepended to the user message (the
// pre_llm_call `{"context": "..."}` channel), so the codex Markdown renderer's
// section layout works verbatim until the two formats need to diverge. Kept as
// a dedicated module so a future hermes-specific layout has a home without
// touching the codex adapter.
export {
  renderCodexStartupContext as renderHermesStartupContext,
  renderCodexLiveUpdate as renderHermesLiveUpdate,
} from '../codex/renderer.js';
