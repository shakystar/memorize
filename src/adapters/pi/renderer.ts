// pi renders Markdown in its context window the same way codex does, so the
// codex renderer's section layout is reused verbatim until the two formats need
// to diverge. Kept as a dedicated module so a future pi-specific layout has a
// home without touching the codex adapter.
export {
  renderCodexStartupContext as renderPiStartupContext,
  renderCodexLiveUpdate as renderPiLiveUpdate,
} from '../codex/renderer.js';
