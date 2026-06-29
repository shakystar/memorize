#!/usr/bin/env bash
# Hermes (NousResearch/hermes-agent) conformance descriptor. Sourced by run.sh.
#
# Hermes is the first 'yaml-shell-hooks' harness: `memorize init` merges memorize
# hooks + an MCP server into ~/.hermes/config.yaml, pre-approves memorize's own
# commands in ~/.hermes/shell-hooks-allowlist.json, and plants the AGENTS.md
# ground rule (Hermes reads AGENTS.md natively). There is NO planted plugin —
# the config commands are `memorize hook hermes <event>` directly, since
# memorize already speaks Hermes's stdin/stdout JSON hook contract.
#
# DOGFOOD SCOPE (honest): the real Hermes CLI ships as a curl|bash installer that
# bundles its OWN uv+python+node runtime (hundreds of MB) and needs a Nous
# provider key even to boot a session — impractical to run on every PR, and we
# hold no Nous key for a live model run. So the deterministic tiers STUB
# detection (mkdir ~/.hermes) and validate the MEMORIZE side end-to-end: the
# config.yaml/allowlist schema we WRITE, the hook stdin→stdout wire contract
# (incl. the {"context": …} translation + once-per-session injection gate), and
# capture across Hermes's tool names. The real CLI is installed only when
# HERMES_CONFORMANCE_LIVE=1 (schedule/dispatch); upstream config-schema drift is
# otherwise tracked manually. This mirrors Gemini's "synthetic-first" posture.

CONFIG="$HOME/.hermes/config.yaml"
ALLOWLIST="$HOME/.hermes/shell-hooks-allowlist.json"
GROUND_RULE="/work/sample/AGENTS.md"

install_harness() {
  if [ "${HERMES_CONFORMANCE_LIVE:-}" = "1" ]; then
    curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash >/dev/null 2>&1 \
      || { echo "  hermes installer failed (network/provider?)"; return 1; }
    command -v hermes >/dev/null 2>&1 || export PATH="$HOME/.hermes/bin:$PATH"
    command -v hermes >/dev/null 2>&1 || return 1
    echo "  hermes $(hermes --version 2>/dev/null | head -1 || echo '?')"
  else
    mkdir -p "$HOME/.hermes"
    echo "  hermes (detection stub: ~/.hermes; real CLI gated on HERMES_CONFORMANCE_LIVE)"
  fi
}

assert_artifacts() {
  if [ -f "$CONFIG" ] \
    && grep -q 'hook hermes pre_llm_call' "$CONFIG" \
    && grep -q 'hook hermes post_tool_call' "$CONFIG" \
    && grep -q 'hook hermes on_session_finalize' "$CONFIG"; then
    ok "~/.hermes/config.yaml registers memorize pre_llm_call + post_tool_call + on_session_finalize hooks"
  else
    ko "~/.hermes/config.yaml missing memorize hooks"
  fi

  if [ -f "$CONFIG" ] && grep -q 'mcp_servers' "$CONFIG" && grep -q '@shakystar/memorize' "$CONFIG"; then
    ok "~/.hermes/config.yaml registers the memorize MCP server (mcp_servers)"
  else
    ko "~/.hermes/config.yaml missing the memorize MCP server"
  fi

  if [ -f "$ALLOWLIST" ] && grep -q 'hook hermes pre_llm_call' "$ALLOWLIST"; then
    ok "shell-hooks-allowlist.json pre-approves memorize's commands (no first-use prompt)"
  else
    ko "shell-hooks-allowlist.json missing memorize approvals"
  fi

  if [ -f "$GROUND_RULE" ] && grep -q 'memorize:ground-rule' "$GROUND_RULE"; then
    ok "AGENTS.md ground-rule block planted"
  else
    ko "AGENTS.md ground-rule block missing"
  fi
}

# Deterministic + model-free (runs every PR). Three facets:
#  (a) capture: feed Hermes's real tool payloads to `memorize hook hermes
#      post_tool_call` (eventHandlerMap → PostToolUse) and assert each category
#      is captured (fresh bound project per tool → independent counts).
#  (b) injection: `memorize hook hermes pre_llm_call` must emit the hermes-native
#      {"context": …} envelope (proves the wire translation off the Claude shape).
#  (c) gate: a SECOND pre_llm_call for the SAME session_id must emit {} — proving
#      the once-per-session injection gate (pre_llm_call fires every turn).
synthetic_capture_check() {
  local spec name payload dir cnt
  for spec in \
    'write_file|{"tool_name":"write_file","tool_input":{"file_path":"a.ts","content":"x"}}' \
    'patch|{"tool_name":"patch","tool_input":{"file_path":"b.ts"}}' \
    'terminal|{"tool_name":"terminal","tool_input":{"command":"rm -rf build"}}'; do
    name="${spec%%|*}"
    payload="${spec#*|}"
    dir="/work/syn-hermes-$name"
    rm -rf "$dir" && mkdir -p "$dir"
    ( cd "$dir" && { git init -q 2>/dev/null || true; } && memorize init >/dev/null 2>&1 )
    printf '%s' "$payload" | ( cd "$dir" && memorize hook hermes post_tool_call >/dev/null 2>&1 )
    cnt="$(_pending_count "$dir")"
    if [ "${cnt:-0}" -ge 1 ]; then
      ok "synthetic capture [$name]: ${cnt} observation(s)"
    else
      ko "synthetic capture [$name] produced no observation (tool-name mapping?)"
    fi
  done

  # Injection + gate. Use a dedicated bound dir so the session_id state is clean.
  local dir err out1 out2
  dir="/work/syn-hermes-inject"
  rm -rf "$dir" && mkdir -p "$dir"
  ( cd "$dir" && { git init -q 2>/dev/null || true; } && memorize init >/dev/null 2>&1 )
  err="$(mktemp)"
  out1="$( cd "$dir" && printf '{"session_id":"hs1"}' | memorize hook hermes pre_llm_call 2>"$err" )"
  if printf '%s' "$out1" | grep -q '"context"'; then
    ok "synthetic injection [pre_llm_call turn 1]: emitted {\"context\": …} (wire translation)"
  else
    ko "synthetic injection [pre_llm_call turn 1] emitted no context envelope"
    echo "    --- pre_llm_call hook stderr ---"
    tail -n 12 "$err" | sed 's/^/      /'
    echo "    --- pre_llm_call hook stdout (first 240 chars) ---"
    printf '%s' "$out1" | head -c 240 | sed 's/^/      /'
    echo ""
  fi
  out2="$( cd "$dir" && printf '{"session_id":"hs1"}' | memorize hook hermes pre_llm_call 2>/dev/null )"
  if printf '%s' "$out2" | grep -q '"context"'; then
    ko "injection gate FAILED: pre_llm_call re-injected on turn 2 (same session_id)"
  else
    ok "injection gate [pre_llm_call turn 2]: no re-injection for the same session_id"
  fi
  rm -f "$err"
}

# Gated (model + real CLI): drive a real `hermes` run and assert capture. Needs
# HERMES_CONFORMANCE_LIVE=1 (which also triggers the real installer) AND a Nous
# provider key — absent in CI, so this skips. memorize capture is LLM-free; the
# model only makes Hermes perform tool calls.
live_capture_check() {
  if [ "${HERMES_CONFORMANCE_LIVE:-}" != "1" ] || ! command -v hermes >/dev/null 2>&1; then
    skip "live capture (set HERMES_CONFORMANCE_LIVE=1 + a Nous provider key; needs the real hermes CLI)"
    return
  fi
  local before after
  before="$(_pending_count /work/sample)"
  if ! ( cd /work/sample && hermes --accept-hooks -p "create a file notes.txt containing the word hi" ) \
    >/work/run.log 2>&1; then
    ko "hermes run failed (provider key/model configured? see below)"
    tail -n 4 /work/run.log | sed 's/^/      /'
    return
  fi
  sleep 3
  after="$(_pending_count /work/sample)"
  if [ "${after:-0}" -gt "${before:-0}" ]; then
    ok "live capture produced $(( ${after:-0} - ${before:-0} )) observation(s) from a real hermes run"
  else
    ko "no observation captured after a live hermes run (tool-name mapping?)"
    tail -n 4 /work/run.log | sed 's/^/      /'
  fi
}
