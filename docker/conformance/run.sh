#!/usr/bin/env bash
#
# Generic harness-conformance runner. Sources a per-harness descriptor
# (harnesses/<id>.sh) and runs three tiers:
#   A. install conformance  — `memorize init` against the REAL harness CLI,
#      then assert the planted artifacts (deterministic, no model).
#   A'. plugin load          — does the real harness load memorize's plugin
#      without a fatal error (best-effort; skips if it can't boot model-free).
#   B. live capture          — drive the harness with a model and assert an
#      observation was captured (GATED on <ID>_CONFORMANCE_LIVE + a provider key).
#
# Exit non-zero if any hard (tier-A) assertion fails. Tier A' / B failures are
# reported but only fail the run when their tier actually executed.
set -uo pipefail

HARNESS="${1:?usage: run.sh <harness-id>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DESC="$HERE/harnesses/$HARNESS.sh"
[ -f "$DESC" ] || { echo "no descriptor for harness '$HARNESS' ($DESC)"; exit 2; }
# shellcheck source=/dev/null
source "$DESC"

PASS=0
FAIL=0
ok()   { echo "  PASS: $1"; PASS=$((PASS + 1)); }
ko()   { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
skip() { echo "  SKIP: $1"; }

echo "== [$HARNESS] install harness CLI =="
if ! install_harness; then
  echo "harness CLI install failed — cannot run conformance"
  exit 2
fi

echo "== [$HARNESS] memorize init (real harness present) =="
SAMPLE=/work/sample
rm -rf "$SAMPLE" && mkdir -p "$SAMPLE"
( cd "$SAMPLE" && git init -q 2>/dev/null || true )
( cd "$SAMPLE" && memorize init ) 2>&1 | sed 's/^/  /'

echo "== [$HARNESS] tier A: install artifacts =="
assert_artifacts

echo "== [$HARNESS] tier A': plugin load (best-effort) =="
if declare -F plugin_load_check >/dev/null; then plugin_load_check; else skip "no plugin_load_check"; fi

echo "== [$HARNESS] tier B: live capture (gated) =="
if declare -F live_capture_check >/dev/null; then live_capture_check; else skip "no live_capture_check"; fi

echo "== [$HARNESS] summary: PASS=$PASS FAIL=$FAIL =="
[ "$FAIL" -eq 0 ]
