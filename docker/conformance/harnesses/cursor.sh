#!/usr/bin/env bash
# Cursor conformance descriptor. Sourced by run.sh.
#
# Cursor is a json-hooks-map harness, but PER-PROJECT: `memorize init` writes
# memorize hooks into <project>/.cursor/hooks.json (the four native events
# sessionStart/postToolUse/preCompact/sessionEnd), merges the memorize MCP
# server into <project>/.cursor/mcp.json, and plants the AGENTS.md ground rule
# (Cursor reads AGENTS.md/CLAUDE.md natively as rules).
#
# DOGFOOD SCOPE (honest — WEAKER than gemini/hermes): Cursor is a GUI IDE (and a
# closed-source Electron app) with NO headless/CLI agent we can drive in a
# container. So there is no real binary to install (detection is stubbed by
# creating ~/.cursor), NO plugin to load-check, and — unlike every other
# harness — NO live_capture tier is even possible: nothing can perform a tool
# call without the GUI. We validate the MEMORIZE side end-to-end deterministically:
# the .cursor/hooks.json + .cursor/mcp.json schema we WRITE, and the hook
# stdin→stdout wire contract (capture across cursor's tool names + the
# sessionStart {"additional_context": …} injection envelope). Upstream
# config-schema drift is tracked manually against cursor.com/docs/hooks.

HOOKS="/work/sample/.cursor/hooks.json"
MCP="/work/sample/.cursor/mcp.json"
GROUND_RULE="/work/sample/AGENTS.md"

install_harness() {
  # Cursor has no installable headless CLI — stub the detection signal so
  # `memorize init` wires the integration, exactly as it would on a real
  # machine where the user has run the Cursor IDE at least once.
  mkdir -p "$HOME/.cursor"
  echo "  cursor (detection stub: ~/.cursor; GUI IDE — no headless CLI, live tier N/A)"
}

assert_artifacts() {
  if [ -f "$HOOKS" ] \
    && grep -q 'hook cursor sessionStart' "$HOOKS" \
    && grep -q 'hook cursor postToolUse' "$HOOKS" \
    && grep -q 'hook cursor preCompact' "$HOOKS" \
    && grep -q 'hook cursor sessionEnd' "$HOOKS"; then
    ok ".cursor/hooks.json registers memorize sessionStart + postToolUse + preCompact + sessionEnd hooks"
  else
    ko ".cursor/hooks.json missing memorize hooks"
  fi

  if [ -f "$MCP" ] && grep -q 'mcpServers' "$MCP" && grep -q '@shakystar/memorize' "$MCP"; then
    ok ".cursor/mcp.json registers the memorize MCP server (mcpServers)"
  else
    ko ".cursor/mcp.json missing the memorize MCP server"
  fi

  if [ -f "$GROUND_RULE" ] && grep -q 'memorize:ground-rule' "$GROUND_RULE"; then
    ok "AGENTS.md ground-rule block planted"
  else
    ko "AGENTS.md ground-rule block missing"
  fi
}

# Deterministic + model-free (runs every PR). Two facets:
#  (a) capture: feed Cursor's real tool payloads to `memorize hook cursor
#      postToolUse` (eventHandlerMap → PostToolUse) and assert each category is
#      captured (fresh bound project per tool → independent counts). Verifies the
#      capture filter's cursor tool names (Write shared with Claude; Shell new).
#  (b) injection: `memorize hook cursor sessionStart` must emit the cursor-native
#      {"additional_context": …} envelope (proves the wire translation off the
#      Claude shape — snake_case, top-level, NOT hookSpecificOutput).
synthetic_capture_check() {
  local spec name payload dir cnt
  for spec in \
    'Write|{"tool_name":"Write","tool_input":{"file_path":"a.ts","content":"x"}}' \
    'Shell|{"tool_name":"Shell","tool_input":{"command":"rm -rf build"}}'; do
    name="${spec%%|*}"
    payload="${spec#*|}"
    dir="/work/syn-cursor-$name"
    rm -rf "$dir" && mkdir -p "$dir"
    ( cd "$dir" && { git init -q 2>/dev/null || true; } && memorize init >/dev/null 2>&1 )
    printf '%s' "$payload" | ( cd "$dir" && memorize hook cursor postToolUse >/dev/null 2>&1 )
    cnt="$(_pending_count "$dir")"
    if [ "${cnt:-0}" -ge 1 ]; then
      ok "synthetic capture [$name]: ${cnt} observation(s)"
    else
      ko "synthetic capture [$name] produced no observation (tool-name mapping?)"
    fi
  done

  # Injection: a dedicated bound dir keeps the session state clean.
  local dir err out
  dir="/work/syn-cursor-inject"
  rm -rf "$dir" && mkdir -p "$dir"
  ( cd "$dir" && { git init -q 2>/dev/null || true; } && memorize init >/dev/null 2>&1 )
  err="$(mktemp)"
  out="$( cd "$dir" && printf '{"session_id":"cs1"}' | memorize hook cursor sessionStart 2>"$err" )"
  if printf '%s' "$out" | grep -q '"additional_context"'; then
    ok "synthetic injection [sessionStart]: emitted {\"additional_context\": …} (wire translation)"
  else
    ko "synthetic injection [sessionStart] emitted no additional_context envelope"
    echo "    --- sessionStart hook stderr ---"
    tail -n 12 "$err" | sed 's/^/      /'
    echo "    --- sessionStart hook stdout (first 240 chars) ---"
    printf '%s' "$out" | head -c 240 | sed 's/^/      /'
    echo ""
  fi
  rm -f "$err"
}

# NO live_capture_check: Cursor is a GUI IDE with no headless agent to drive, so
# a real model-driven tool call cannot be produced in CI (or anywhere scriptable).
# run.sh skips the tier when the function is absent — this absence is intentional
# and documented, not an oversight.
