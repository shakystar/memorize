#!/usr/bin/env bash
# AI_SETUP one-liner stress harness (WSL / Linux).
# Same design as run-stress.ps1: per-run fake HOME, isolated npm prefix,
# scrubbed PATH via a shim dir, isolated CLAUDE_CONFIG_DIR seeded with
# credentials only, leak detection against the real HOME.
#
# Sandboxes/results live on the Linux fs (default ~/memorize-stress/results)
# because npm installs on /mnt/c are painfully slow.
#
# Self-test:  bash run-stress.sh --total 2 --skip-claude
# Pilot:      bash run-stress.sh --total 1
# Full:       bash run-stress.sh --total 100 --mix mixed

set -u

TOTAL=100
MIX=mixed          # mixed | base | matrix
START_AT=1
TIMEOUT_MIN=15
RATE_WAIT_MIN=20
MAX_RATE_RETRIES=6
SKIP_CLAUDE=0
RESULTS_ROOT="$HOME/memorize-stress/results"

while [ $# -gt 0 ]; do
  case "$1" in
    --total) TOTAL="$2"; shift 2 ;;
    --mix) MIX="$2"; shift 2 ;;
    --start-at) START_AT="$2"; shift 2 ;;
    --timeout-min) TIMEOUT_MIN="$2"; shift 2 ;;
    --skip-claude) SKIP_CLAUDE=1; shift ;;
    --results-root) RESULTS_ROOT="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY="$HARNESS_DIR/lib/verify.mjs"
STRESS_HOME="$(dirname "$RESULTS_ROOT")"
NPM_CACHE="$STRESS_HOME/npm-cache"
SHIMS="$STRESS_HOME/shims"
PROMPT='Follow this guide to set up memorize in this project: https://github.com/shakystar/memorize/blob/main/guides/AI_SETUP.md'

mkdir -p "$RESULTS_ROOT" "$NPM_CACHE"

# ---------- shims ----------
rm -rf "$SHIMS"; mkdir -p "$SHIMS"
HAS_PNPM=0
for t in node npm npx git claude pnpm; do
  src="$(command -v "$t" 2>/dev/null || true)"
  if [ -z "$src" ]; then
    if [ "$t" = pnpm ]; then continue; fi
    if [ "$t" = claude ] && [ "$SKIP_CLAUDE" -eq 1 ]; then continue; fi
    echo "required tool not found on host PATH: $t" >&2; exit 1
  fi
  [ "$t" = pnpm ] && HAS_PNPM=1
  ln -s "$src" "$SHIMS/$t"
done
# verify.mjs runs `sh -c` lines through the shell; keep core utils reachable via /usr/bin:/bin

# ---------- credentials ----------
REAL_CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CRED="$REAL_CFG/.credentials.json"
if [ "$SKIP_CLAUDE" -eq 0 ] && [ ! -f "$CRED" ]; then
  echo "claude credentials not found at $CRED - run 'claude' in WSL once and log in" >&2; exit 1
fi

# ---------- helpers ----------

hash_or_absent() { [ -f "$1" ] && sha256sum "$1" | cut -d' ' -f1 || echo absent; }

leak_snapshot() {  # $1 = output file
  {
    echo "claudeSettings=$(hash_or_absent "$REAL_CFG/settings.json")"
    echo "codexHooks=$(hash_or_absent "$HOME/.codex/hooks.json")"
    echo "bashrc=$(hash_or_absent "$HOME/.bashrc")"
    echo "profile=$(hash_or_absent "$HOME/.profile")"
    echo "memorizeDir=$( [ -d "$HOME/.memorize" ] && ls -1 "$HOME/.memorize" | sort | tr '\n' ',' || echo absent)"
  } > "$1"
}

make_fixture() {  # $1 = scenario, $2 = project dir
  local scenario="$1" proj="$2"
  mkdir -p "$proj"
  printf '# stress fixture (%s)\n' "$scenario" > "$proj/README.md"
  case "$scenario" in
    node-basic)
      printf '{ "name": "stress-fixture", "version": "1.0.0", "private": true }\n' > "$proj/package.json"
      printf 'console.log("hi");\n' > "$proj/index.js" ;;
    non-node)
      mkdir -p "$proj/src"; printf 'print("hi")\n' > "$proj/src/main.py" ;;
    pnpm-monorepo)
      printf '{ "name": "stress-root", "version": "1.0.0", "private": true }\n' > "$proj/package.json"
      printf 'packages:\n  - packages/*\n' > "$proj/pnpm-workspace.yaml"
      mkdir -p "$proj/packages/app"
      printf '{ "name": "app", "version": "1.0.0", "private": true }\n' > "$proj/packages/app/package.json" ;;
    existing-docs)
      printf '{ "name": "stress-fixture", "version": "1.0.0", "private": true }\n' > "$proj/package.json"
      printf 'console.log("hi");\n' > "$proj/index.js"
      printf '# Project rules\n\n- Always write tests first.\n- API responses use snake_case.\n' > "$proj/CLAUDE.md"
      printf 'Prefer small functions. Never commit secrets.\n' > "$proj/.cursorrules" ;;
  esac
  git -C "$proj" init -q
  git -C "$proj" -c user.name=stress -c user.email=stress@test.local add -A
  git -C "$proj" -c user.name=stress -c user.email=stress@test.local commit -q -m fixture
}

sandbox_env() {  # $1 = run dir; prints env assignments for `env -i`
  local run="$1"
  echo "HOME=$run/home"
  echo "USER=${USER:-stress}"
  echo "LOGNAME=${USER:-stress}"
  echo "SHELL=/bin/bash"
  echo "TERM=xterm-256color"
  echo "LANG=C.UTF-8"
  echo "TMPDIR=$run/tmp"
  echo "CLAUDE_CONFIG_DIR=$run/claude-config"
  echo "npm_config_prefix=$run/prefix"
  echo "npm_config_cache=$NPM_CACHE"
  echo "npm_config_update_notifier=false"
  echo "DISABLE_AUTOUPDATER=1"
  echo "PATH=$SHIMS:$run/prefix/bin:/usr/bin:/bin"
}

run_sandboxed() {  # $1=run dir  $2=cwd  $3=timeout sec  $4=out  $5=err  $6...=command
  local run="$1" cwd="$2" tmo="$3" out="$4" err="$5"; shift 5
  local -a envs; mapfile -t envs < <(sandbox_env "$run")
  ( cd "$cwd" && timeout -k 30 "$tmo" env -i "${envs[@]}" "$@" ) > "$out" 2> "$err"
}

# ---------- manifest ----------
MATRIX=(non-node existing-docs)
[ "$HAS_PNPM" -eq 1 ] && MATRIX+=(pnpm-monorepo) || echo "warning: pnpm not found - pnpm-monorepo scenario excluded" >&2

scenario_for() {  # $1 = 1-based index
  local i="$1" half=$(( (TOTAL + 1) / 2 ))
  case "$MIX" in
    base) echo node-basic ;;
    matrix) echo "${MATRIX[$(( (i - 1) % ${#MATRIX[@]} ))]}" ;;
    mixed) if [ "$i" -le "$half" ]; then echo node-basic; else echo "${MATRIX[$(( (i - 1) % ${#MATRIX[@]} ))]}"; fi ;;
  esac
}

# ---------- main loop ----------
echo "== setup-stress (wsl): $TOTAL runs (mix=$MIX), results -> $RESULTS_ROOT"

for i in $(seq "$START_AT" "$TOTAL"); do
  scenario="$(scenario_for "$i")"
  run_id="$(printf 'run-%03d' "$i")"
  run="$RESULTS_ROOT/$run_id"
  if [ -f "$run/meta.json" ]; then echo "$run_id already done, skipping"; continue; fi
  rm -rf "$run"
  mkdir -p "$run/home" "$run/project" "$run/claude-config" "$run/prefix" "$run/tmp"

  printf '[user]\n\tname = stress\n\temail = stress@test.local\n[init]\n\tdefaultBranch = main\n' > "$run/home/.gitconfig"
  [ -f "$CRED" ] && cp "$CRED" "$run/claude-config/.credentials.json"
  printf '{ "hasCompletedOnboarding": true, "bypassPermissionsModeAccepted": true }\n' > "$run/claude-config/.claude.json"
  printf '{}\n' > "$run/claude-config/settings.json"
  make_fixture "$scenario" "$run/project"

  # preflight: memorize must NOT resolve in the sandbox; node must
  if run_sandboxed "$run" "$run/project" 30 "$run/pf-memorize.txt" "$run/pf-memorize.err" sh -c 'command -v memorize'; then
    echo "$run_id preflight FAILED: memorize resolvable inside sandbox: $(cat "$run/pf-memorize.txt")" >&2; exit 1
  fi
  if ! run_sandboxed "$run" "$run/project" 30 "$run/pf-node.txt" "$run/pf-node.err" node --version; then
    echo "$run_id preflight FAILED: node not resolvable inside sandbox" >&2; exit 1
  fi

  leak_snapshot "$run/leak-before.txt"
  started="$(date -Iseconds)"
  claude_exit=""; claude_dur=0; timed_out=false; rate_retries=0

  if [ "$SKIP_CLAUDE" -eq 0 ]; then
    while :; do
      echo "[$(date +%H:%M:%S)] $run_id scenario=$scenario claude -p ..."
      t0=$SECONDS
      run_sandboxed "$run" "$run/project" $(( TIMEOUT_MIN * 60 )) "$run/stdout.ndjson" "$run/stderr.txt" \
        claude -p "$PROMPT" --output-format stream-json --verbose --dangerously-skip-permissions
      claude_exit=$?
      claude_dur=$(( SECONDS - t0 ))
      [ "$claude_exit" -eq 124 ] || [ "$claude_exit" -eq 137 ] && timed_out=true
      if [ "$claude_exit" -ne 0 ] && [ "$rate_retries" -lt "$MAX_RATE_RETRIES" ] \
         && tail -n 30 "$run/stdout.ndjson" "$run/stderr.txt" 2>/dev/null | grep -Eqi 'usage limit|rate limit|overloaded|429'; then
        rate_retries=$(( rate_retries + 1 ))
        echo "$run_id hit rate limit, waiting ${RATE_WAIT_MIN}m (retry $rate_retries/$MAX_RATE_RETRIES)" >&2
        sleep $(( RATE_WAIT_MIN * 60 )); continue
      fi
      break
    done
  fi

  run_sandboxed "$run" "$run/project" 600 "$run/verify.json" "$run/verify.err" node "$VERIFY" "$run/project"
  verify_exit=$?

  leak_snapshot "$run/leak-after.txt"
  if diff -u "$run/leak-before.txt" "$run/leak-after.txt" > "$run/leak.diff" 2>&1; then leaks=0; else leaks=1; fi

  cat > "$run/meta.json" <<EOF
{ "runId": "$run_id", "scenario": "$scenario", "platform": "wsl", "skipClaude": $([ "$SKIP_CLAUDE" -eq 1 ] && echo true || echo false),
  "startedAt": "$started", "claudeExit": ${claude_exit:-null}, "claudeTimedOut": $timed_out,
  "claudeDurationSec": $claude_dur, "verifyExit": $verify_exit, "rateLimitRetries": $rate_retries, "leakCount": $leaks }
EOF

  vtag=$([ "$verify_exit" -eq 0 ] && echo VERIFY-OK || echo VERIFY-FAIL)
  ltag=$([ "$leaks" -gt 0 ] && echo " LEAKS" || echo "")
  echo "[$(date +%H:%M:%S)] $run_id done: claude exit=${claude_exit:-skipped} (${claude_dur}s) $vtag$ltag"
done

echo "== all runs complete. Aggregate with: node $HARNESS_DIR/aggregate.mjs $RESULTS_ROOT"
