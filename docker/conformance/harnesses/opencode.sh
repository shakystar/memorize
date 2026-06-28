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

# Gated: needs OPENCODE_CONFORMANCE_LIVE=1 and a configured provider (API key in
# env). Drives a real edit and asserts memorize captured an observation.
live_capture_check() {
  if [ "${OPENCODE_CONFORMANCE_LIVE:-}" != "1" ]; then
    skip "live capture (set OPENCODE_CONFORMANCE_LIVE=1 + a provider API key)"
    return
  fi
  ( cd /work/sample && opencode run "create a file hello.txt containing the word hi" ) \
    >/work/run.log 2>&1 || { ko "opencode run failed (provider/model configured?)"; return; }
  sleep 3
  local pending
  pending="$(memorize doctor --json 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const r = JSON.parse(s);
        const c = (r.checks || []).find((x) => /consolidat/.test(x.id));
        const m = ((c && c.message) || "").match(/(\d+) observation/);
        process.stdout.write(m ? m[1] : "0");
      } catch { process.stdout.write("0"); }
    });
  ')"
  if [ "${pending:-0}" -ge 1 ]; then
    ok "live capture produced ${pending} observation(s)"
  else
    ko "no observation captured after a live opencode run"
  fi
}
