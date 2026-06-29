#!/usr/bin/env bash
# pi conformance descriptor. Sourced by run.sh; defines how to install pi
# (earendil-works) and how to assert memorize's integration against it.
#
# pi is the same ts-plugin family as opencode but with a richer hook surface:
# `memorize init` plants a global TS extension (~/.pi/agent/extensions/memorize.ts)
# that injects session-start memory via before_agent_start (pi CAN inject a model
# message — opencode cannot), captures on tool_result, and runs the compaction
# boundary on session_compact. It also merges an MCP block into
# ~/.pi/agent/mcp.json and writes the AGENTS.md ground rule (pi reads AGENTS.md
# natively). memorize detects pi by its launcher on PATH and by ~/.pi.

EXT="$HOME/.pi/agent/extensions/memorize.ts"
MCP_CFG="$HOME/.pi/agent/mcp.json"
GROUND_RULE="/work/sample/AGENTS.md"

install_harness() {
  npm i -g @earendil-works/pi-coding-agent@latest >/dev/null 2>&1 || return 1
  command -v pi >/dev/null 2>&1 || return 1
  echo "  pi $(pi --version 2>/dev/null | head -1 || echo '?')"
}

assert_artifacts() {
  if [ -f "$EXT" ] \
    && grep -q 'before_agent_start' "$EXT" \
    && grep -q 'tool_result' "$EXT" \
    && grep -q 'session_compact' "$EXT"; then
    ok "capture+inject extension planted at ~/.pi/agent/extensions/memorize.ts"
  else
    ko "pi extension missing or not subscribing to the expected lifecycle events"
  fi

  if [ -f "$MCP_CFG" ] && grep -q '"memorize"' "$MCP_CFG"; then
    ok "~/.pi/agent/mcp.json registers the memorize MCP server"
  else
    ko "~/.pi/agent/mcp.json missing the memorize MCP server"
  fi

  if [ -f "$GROUND_RULE" ] && grep -q 'memorize:ground-rule' "$GROUND_RULE"; then
    ok "AGENTS.md ground-rule block planted"
  else
    ko "AGENTS.md ground-rule block missing"
  fi
}

# Deterministic + model-free (runs every PR). Two facets:
#  (a) capture: feed the MAPPED tool payloads the extension emits (after
#      TOOL_NAME_MAP) to the REAL `memorize hook pi PostToolUse` and assert each
#      category is captured (fresh bound project per tool → independent counts).
#  (b) injection: `memorize hook pi SessionStart` must emit the additionalContext
#      JSON the extension's before_agent_start reads back — verifies the
#      session-start memory path the extension depends on, no model, no flake.
synthetic_capture_check() {
  local spec name payload dir cnt
  for spec in \
    'write|{"tool_name":"Write","tool_input":{"file_path":"a.ts","content":"x"}}' \
    'edit|{"tool_name":"Edit","tool_input":{"file_path":"b.ts"}}' \
    'bash|{"tool_name":"shell","tool_input":{"command":"rm -rf build"}}'; do
    name="${spec%%|*}"
    payload="${spec#*|}"
    dir="/work/syn-pi-$name"
    rm -rf "$dir" && mkdir -p "$dir"
    ( cd "$dir" && { git init -q 2>/dev/null || true; } && memorize init >/dev/null 2>&1 )
    printf '%s' "$payload" | ( cd "$dir" && memorize hook pi PostToolUse >/dev/null 2>&1 )
    cnt="$(_pending_count "$dir")"
    if [ "${cnt:-0}" -ge 1 ]; then
      ok "synthetic capture [$name → mapped]: ${cnt} observation(s)"
    else
      ko "synthetic capture [$name] produced no observation (deployed hook path?)"
    fi
  done

  # Injection path: the SessionStart hook must print additionalContext for the
  # extension's before_agent_start to inject. Capture stderr so a throw in the
  # heavier handleSessionStart flow (startSession / locks / detached consolidate)
  # surfaces here instead of being swallowed.
  local out err
  err="$(mktemp)"
  out="$( cd /work/sample && printf '{}' | memorize hook pi SessionStart 2>"$err" )"
  if printf '%s' "$out" | grep -q 'additionalContext'; then
    ok "synthetic injection [SessionStart]: emitted additionalContext for before_agent_start"
  else
    ko "synthetic injection [SessionStart] emitted no additionalContext (injection path?)"
    echo "    --- SessionStart hook stderr ---"
    tail -n 12 "$err" | sed 's/^/      /'
    echo "    --- SessionStart hook stdout (first 240 chars) ---"
    printf '%s' "$out" | head -c 240 | sed 's/^/      /'
    echo ""
  fi
  rm -f "$err"
}

# Gated (model; schedule/dispatch): drive REAL pi tool use and assert capture
# end-to-end. The debug dump reveals pi's real tool names so the extension's
# TOOL_NAME_MAP is verified against the live harness. memorize capture is
# LLM-free; the model only makes pi perform tool calls (cheap model OK).
live_capture_check() {
  if [ "${PI_CONFORMANCE_LIVE:-}" != "1" ] || [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    skip "live capture (set PI_CONFORMANCE_LIVE=1 + ANTHROPIC_API_KEY)"
    return
  fi
  local model="${PI_MODEL:-anthropic/claude-haiku-4-5}"
  export MEMORIZE_PI_DEBUG=1
  rm -f "$HOME/memorize-pi-debug.log"
  local before after
  before="$(_pending_count /work/sample)"
  # Prompt encourages write THEN edit so the run exercises both tools — their
  # real pi tool names then appear in the debug dump for map verification.
  if ! ( cd /work/sample && pi --model "$model" -p "create a file notes.txt containing 'hi', then edit notes.txt so it contains 'hello world'" ) >/work/run.log 2>&1; then
    ko "pi run failed (model=$model; ANTHROPIC_API_KEY set? see below)"
    tail -n 4 /work/run.log | sed 's/^/      /'
    return
  fi
  sleep 3
  echo "  --- extension debug log (real pi tool names / payloads) ---"
  head -c 3000 "$HOME/memorize-pi-debug.log" 2>/dev/null | sed 's/^/    /' || echo "    (no debug log — extension tool_result never fired)"
  echo "  --- end debug log ---"
  after="$(_pending_count /work/sample)"
  if [ "${after:-0}" -gt "${before:-0}" ]; then
    ok "live capture produced $(( ${after:-0} - ${before:-0} )) observation(s) from a real pi run"
  else
    ko "no observation captured after a live pi run (tool-name mapping?)"
    tail -n 4 /work/run.log | sed 's/^/      /'
  fi
}
