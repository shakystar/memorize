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

# Pull the EXACT memorize command string that `memorize init` wrote into a
# .cursor/hooks.json for a given event. This is what makes the synthetic tier
# FAITHFUL: we execute the artifact we actually installed (node-abs/bare form,
# whatever the writer resolved), driven the way Cursor's runtime drives it —
# rather than a hand-typed `memorize hook cursor …` proxy that could silently
# diverge from what we wrote. Empty output ⇒ the writer drifted (a real failure).
_cursor_hook_cmd() {
  node -e '
    const fs = require("fs");
    try {
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const arr = (j.hooks && j.hooks[process.argv[2]]) || [];
      const m = arr.find((e) => /hook cursor /.test(e.command || ""));
      process.stdout.write(m ? m.command : "");
    } catch { process.stdout.write(""); }
  ' "$1" "$2"
}

# Deterministic + model-free (runs every PR). FAITHFUL: it runs the command
# entries memorize WROTE into each project's .cursor/hooks.json — the closest
# automatable proxy for opening Cursor — driven by Cursor's documented payloads
# the way Cursor's runtime drives them (project-root cwd, JSON on stdin). Two facets:
#  (a) capture: each cursor tool payload through the written `postToolUse` command
#      (eventHandlerMap → PostToolUse) must be captured (fresh bound project per
#      tool → independent counts). Verifies the capture filter's cursor tool names
#      (Write shared with Claude; Shell new) AND that the written command runs.
#  (b) injection: the written `sessionStart` command must emit the cursor-native
#      {"additional_context": …} envelope (wire translation off the Claude shape —
#      snake_case, top-level, NOT hookSpecificOutput).
synthetic_capture_check() {
  local spec name payload dir cmd cnt
  for spec in \
    'Write|{"tool_name":"Write","tool_input":{"file_path":"a.ts","content":"x"}}' \
    'Shell|{"tool_name":"Shell","tool_input":{"command":"rm -rf build"}}'; do
    name="${spec%%|*}"
    payload="${spec#*|}"
    dir="/work/syn-cursor-$name"
    rm -rf "$dir" && mkdir -p "$dir"
    ( cd "$dir" && { git init -q 2>/dev/null || true; } && memorize init >/dev/null 2>&1 )
    cmd="$(_cursor_hook_cmd "$dir/.cursor/hooks.json" postToolUse)"
    if [ -z "$cmd" ]; then
      ko "synthetic capture [$name]: no memorize postToolUse command in .cursor/hooks.json (writer drift)"
      continue
    fi
    printf '%s' "$payload" | ( cd "$dir" && eval "$cmd" >/dev/null 2>&1 )
    cnt="$(_pending_count "$dir")"
    if [ "${cnt:-0}" -ge 1 ]; then
      ok "synthetic capture [$name]: ${cnt} observation(s) via the written hooks.json command"
    else
      ko "synthetic capture [$name] produced no observation (tool-name mapping?)"
    fi
  done

  # Injection: a dedicated bound dir keeps the session state clean.
  local dir err out
  dir="/work/syn-cursor-inject"
  rm -rf "$dir" && mkdir -p "$dir"
  ( cd "$dir" && { git init -q 2>/dev/null || true; } && memorize init >/dev/null 2>&1 )
  cmd="$(_cursor_hook_cmd "$dir/.cursor/hooks.json" sessionStart)"
  if [ -z "$cmd" ]; then
    ko "synthetic injection [sessionStart]: no memorize sessionStart command in .cursor/hooks.json (writer drift)"
    return
  fi
  err="$(mktemp)"
  out="$( cd "$dir" && printf '{"session_id":"cs1"}' | eval "$cmd" 2>"$err" )"
  if printf '%s' "$out" | grep -q '"additional_context"'; then
    ok "synthetic injection [sessionStart]: emitted {\"additional_context\": …} via the written hooks.json command"
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

# Tier C — upstream CONTRACT drift guard (gated on CURSOR_CONFORMANCE_LIVE=1).
# Since Cursor has no driveable CLI, the published hooks contract is the ONLY
# external truth that can catch upstream renames. Fetch the live docs and assert
# every token memorize hardcodes still appears: the four event names, the
# injection field, the per-tool tool_name we capture on, and the config paths.
# A miss ⇒ Cursor changed its contract and our (otherwise-green) synthetic tier
# is now testing a stale assumption — exactly the drift manual doc-watching used
# to catch. Gated + scheduled (network); the synthetic tier still runs every PR.
CURSOR_DOCS_URL="${CURSOR_DOCS_URL:-https://cursor.com/docs/hooks}"

contract_check() {
  if [ "${CURSOR_CONFORMANCE_LIVE:-}" != "1" ]; then
    skip "upstream contract (set CURSOR_CONFORMANCE_LIVE=1 to fetch ${CURSOR_DOCS_URL} and assert the hooks contract)"
    return
  fi
  local docs
  docs="$(curl -fsSL "$CURSOR_DOCS_URL" 2>/dev/null || curl -fsSL "${CURSOR_DOCS_URL}.md" 2>/dev/null)"
  if [ -z "$docs" ]; then
    ko "upstream contract: could not fetch ${CURSOR_DOCS_URL} (network?) — cannot verify drift"
    return
  fi
  local token miss=0
  # event names (must match registry hookEvents), injection field (must match
  # injectionWire 'additional_context'), captured tool names, and config paths.
  # Bare tool-name words (not quoted): the docs list them as filter values —
  # "Values include Shell, Read, Write, Grep, Delete, Task" — and only `Shell`
  # appears quoted (in the tool_name example), so grep the canonical list form.
  for token in \
    sessionStart postToolUse preCompact sessionEnd \
    additional_context \
    Shell Write tool_name \
    '.cursor/hooks.json'; do
    if printf '%s' "$docs" | grep -qF "$token"; then
      ok "upstream contract: docs still mention \`${token}\`"
    else
      ko "upstream contract: \`${token}\` NOT found in ${CURSOR_DOCS_URL} — Cursor may have renamed it (memorize integration drift)"
      miss=$((miss + 1))
    fi
  done
  [ "$miss" -eq 0 ] && ok "upstream contract: all ${CURSOR_DOCS_URL} tokens memorize depends on are present"
}
