#!/usr/bin/env bash
# Gemini CLI conformance descriptor. Sourced by run.sh.
#
# Gemini is a json-hooks-map harness: `memorize init` writes memorize hooks into
# ~/.gemini/settings.json (SessionStart + AfterTool) and plants the GEMINI.md
# ground rule. No plugin to load (hooks are config), so no plugin_load_check.

SETTINGS="$HOME/.gemini/settings.json"
GROUND_RULE="/work/sample/GEMINI.md"

install_harness() {
  npm i -g @google/gemini-cli@latest >/dev/null 2>&1 || return 1
  command -v gemini >/dev/null 2>&1 || return 1
  echo "  gemini $(gemini --version 2>/dev/null | head -1 || echo '?')"
}

assert_artifacts() {
  if [ -f "$SETTINGS" ] \
    && grep -q 'hook gemini SessionStart' "$SETTINGS" \
    && grep -q 'hook gemini AfterTool' "$SETTINGS"; then
    ok "~/.gemini/settings.json registers memorize SessionStart + AfterTool hooks"
  else
    ko "~/.gemini/settings.json missing memorize hooks"
  fi

  if [ -f "$GROUND_RULE" ] && grep -q 'memorize:ground-rule' "$GROUND_RULE"; then
    ok "GEMINI.md ground-rule block planted"
  else
    ko "GEMINI.md ground-rule block missing"
  fi
}

# Deterministic + model-free: feed Gemini's real AfterTool tool names to the
# real `memorize hook gemini AfterTool` (each in a fresh bound project) and
# assert capture. Verifies eventHandlerMap (AfterTool→PostToolUse) + the capture
# filter's gemini tool names against the deployed binary, no model, no flake.
synthetic_capture_check() {
  local spec name payload dir cnt
  for spec in \
    'write_file|{"tool_name":"write_file","tool_input":{"file_path":"a.ts","content":"x"}}' \
    'replace|{"tool_name":"replace","tool_input":{"file_path":"b.ts"}}' \
    'run_shell_command|{"tool_name":"run_shell_command","tool_input":{"command":"rm -rf build"}}'; do
    name="${spec%%|*}"
    payload="${spec#*|}"
    dir="/work/syn-gem-$name"
    rm -rf "$dir" && mkdir -p "$dir"
    ( cd "$dir" && { git init -q 2>/dev/null || true; } && memorize init >/dev/null 2>&1 )
    printf '%s' "$payload" | ( cd "$dir" && memorize hook gemini AfterTool >/dev/null 2>&1 )
    cnt="$(_pending_count "$dir")"
    if [ "${cnt:-0}" -ge 1 ]; then
      ok "synthetic capture [$name]: ${cnt} observation(s)"
    else
      ko "synthetic capture [$name] produced no observation"
    fi
  done
}

# Gated (model): a real `gemini -p` run that performs a tool call, asserting
# memorize captured it via the AfterTool hook. Needs GEMINI_CONFORMANCE_LIVE=1 +
# GEMINI_API_KEY. (Gemini live uses a Gemini key, distinct from opencode's.)
live_capture_check() {
  if [ "${GEMINI_CONFORMANCE_LIVE:-}" != "1" ] || [ -z "${GEMINI_API_KEY:-}" ]; then
    skip "live capture (set GEMINI_CONFORMANCE_LIVE=1 + GEMINI_API_KEY)"
    return
  fi
  local before after
  before="$(_pending_count /work/sample)"
  if ! ( cd /work/sample && gemini -p "create a file notes.txt containing the word hi" ) \
    >/work/run.log 2>&1; then
    ko "gemini run failed (key/model configured? see below)"
    tail -n 4 /work/run.log | sed 's/^/      /'
    return
  fi
  sleep 3
  after="$(_pending_count /work/sample)"
  if [ "${after:-0}" -gt "${before:-0}" ]; then
    ok "live capture produced $(( ${after:-0} - ${before:-0} )) observation(s) from a real gemini run"
  else
    ko "no observation captured after a live gemini run (tool-name mapping?)"
    tail -n 4 /work/run.log | sed 's/^/      /'
  fi
}
