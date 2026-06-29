#!/usr/bin/env bash
# opencode conformance descriptor. Sourced by run.sh; defines how to install
# opencode and how to assert memorize's integration against it.
#
# memorize detects opencode by its launcher on PATH (installed below) and by
# ~/.config/opencode; `memorize init` then registers the MCP server, plants the
# capture plugin, and writes the AGENTS.md ground rule.

CFG="$HOME/.config/opencode/opencode.json"
PLUGIN="$HOME/.config/opencode/plugins/memorize.ts"
GROUND_RULE="/work/sample/AGENTS.md"

install_harness() {
  npm i -g opencode-ai@latest >/dev/null 2>&1 || return 1
  command -v opencode >/dev/null 2>&1 || return 1
  echo "  opencode $(opencode --version 2>/dev/null || echo '?')"
}

assert_artifacts() {
  if [ -f "$CFG" ] && grep -q '"memorize"' "$CFG" && grep -q '"local"' "$CFG"; then
    ok "opencode.json registers the memorize MCP server"
  else
    ko "opencode.json missing the memorize MCP server"
  fi

  if [ -f "$CFG" ] && grep -q 'AGENTS.md' "$CFG"; then
    ok "opencode 'instructions' includes AGENTS.md"
  else
    ko "opencode 'instructions' missing AGENTS.md"
  fi

  if [ -f "$PLUGIN" ] && grep -q 'tool.execute.after' "$PLUGIN"; then
    ok "capture plugin planted at ~/.config/opencode/plugins/memorize.ts"
  else
    ko "capture plugin not planted"
  fi

  if [ -f "$GROUND_RULE" ] && grep -q 'memorize:ground-rule' "$GROUND_RULE"; then
    ok "AGENTS.md ground-rule block planted"
  else
    ko "AGENTS.md ground-rule block missing"
  fi
}

# Best-effort: boot the headless server (loads plugins at startup) and look for
# a plugin-load error. `opencode serve` should start without a model; if it
# cannot in this environment, we SKIP rather than fail. Tune once validated
# against a real opencode version in CI.
plugin_load_check() {
  local log=/work/serve.log
  ( opencode serve --port 4096 >"$log" 2>&1 & echo $! >/work/serve.pid )
  sleep 6
  local pid; pid="$(cat /work/serve.pid 2>/dev/null || echo '')"
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    skip "opencode serve did not stay up model-free (log: $(tail -n1 "$log" 2>/dev/null))"
    return
  fi
  if grep -qiE 'plugin.*(error|failed)|failed to load.*plugin' "$log"; then
    ko "opencode reported a plugin-load error (see $log)"
  else
    ok "opencode serve booted with the memorize plugin (no load error)"
  fi
  kill "$pid" 2>/dev/null || true
}

# Pending-observation count for the memorize project bound at $1. doctor MUST
# run FROM the bound dir — memorize resolves the project by walking UP from cwd,
# so querying a parent dir would find nothing.
_pending_count() {
  ( cd "$1" && memorize doctor --json 2>/dev/null ) | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const r = JSON.parse(s);
        const c = (r.checks || []).find((x) => /consolidat/.test(x.id));
        const m = ((c && c.message) || "").match(/(\d+) observation/);
        process.stdout.write(m ? m[1] : "0");
      } catch { process.stdout.write("0"); }
    });
  '
}

# Deterministic + model-free (runs every PR): feed the MAPPED tool payloads the
# plugin emits (after TOOL_NAME_MAP) to the REAL `memorize hook opencode` and
# assert each category is captured. Each tool uses a fresh bound project so the
# counts are independent (no threshold-consolidation interference). Guards the
# deployed binary's opencode capture path for write/edit/bash, no flakiness.
synthetic_capture_check() {
  local spec name payload dir cnt
  for spec in \
    'write|{"tool_name":"Write","tool_input":{"file_path":"a.ts","content":"x"}}' \
    'edit|{"tool_name":"Edit","tool_input":{"file_path":"b.ts"}}' \
    'bash|{"tool_name":"shell","tool_input":{"command":"rm -rf build"}}'; do
    name="${spec%%|*}"
    payload="${spec#*|}"
    dir="/work/syn-$name"
    rm -rf "$dir" && mkdir -p "$dir"
    ( cd "$dir" && { git init -q 2>/dev/null || true; } && memorize init >/dev/null 2>&1 )
    printf '%s' "$payload" | ( cd "$dir" && memorize hook opencode PostToolUse >/dev/null 2>&1 )
    cnt="$(_pending_count "$dir")"
    if [ "${cnt:-0}" -ge 1 ]; then
      ok "synthetic capture [$name → mapped]: ${cnt} observation(s)"
    else
      ko "synthetic capture [$name] produced no observation (deployed hook path?)"
    fi
  done
}

# Gated (model; schedule/dispatch): drive REAL opencode tool use and assert
# capture end-to-end. The debug dump reveals opencode's real tool names so the
# plugin's TOOL_NAME_MAP is verified against the live harness. memorize capture
# is LLM-free; the model only makes opencode perform tool calls (cheap model OK).
live_capture_check() {
  if [ "${OPENCODE_CONFORMANCE_LIVE:-}" != "1" ]; then
    skip "live capture (set OPENCODE_CONFORMANCE_LIVE=1 + a provider API key)"
    return
  fi
  local model="${OPENCODE_MODEL:-anthropic/claude-haiku-4-5}"
  # A non-interactive `opencode run` needs a model; write it into the config
  # memorize already created (the provider key is read from env by opencode).
  node -e 'const fs=require("fs");const f=process.argv[1];const c=JSON.parse(fs.readFileSync(f,"utf8"));c.model=process.argv[2];fs.writeFileSync(f,JSON.stringify(c,null,2));' "$CFG" "$model" 2>/dev/null || true
  export MEMORIZE_OPENCODE_DEBUG=1
  rm -f "$HOME/memorize-opencode-debug.log"
  local before after
  before="$(_pending_count /work/sample)"
  # Prompt encourages write THEN edit so the run exercises both tools — their
  # real opencode tool names then appear in the debug dump for map verification.
  if ! ( cd /work/sample && opencode run "create a file notes.txt containing 'hi', then edit notes.txt so it contains 'hello world'" ) >/work/run.log 2>&1; then
    ko "opencode run failed (model=$model; provider key set? see below)"
    tail -n 4 /work/run.log | sed 's/^/      /'
    return
  fi
  sleep 3
  echo "  --- plugin debug log (real opencode tool names / payloads) ---"
  head -c 3000 "$HOME/memorize-opencode-debug.log" 2>/dev/null | sed 's/^/    /' || echo "    (no debug log — plugin tool.execute.after never fired)"
  echo "  --- end debug log ---"
  after="$(_pending_count /work/sample)"
  if [ "${after:-0}" -gt "${before:-0}" ]; then
    ok "live capture produced $(( ${after:-0} - ${before:-0} )) observation(s) from a real opencode run"
  else
    ko "no observation captured after a live opencode run (tool-name mapping?)"
    tail -n 4 /work/run.log | sed 's/^/      /'
  fi
}
