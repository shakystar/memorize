// Cursor injects context as plain text — sessionStart's `additional_context`
// is added to the conversation's initial system context, and postToolUse's is
// injected after the tool result — so the codex Markdown renderer's section
// layout works verbatim until the two formats need to diverge. Kept as a
// dedicated module so a future cursor-specific layout has a home without
// touching the codex adapter.
export {
  renderCodexStartupContext as renderCursorStartupContext,
  renderCodexLiveUpdate as renderCursorLiveUpdate,
} from '../codex/renderer.js';
