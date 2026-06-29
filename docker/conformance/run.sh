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

# Shared helper: pending-observation count for the memorize project bound at $1.
# doctor walks UP from cwd, so it MUST run FROM the bound dir. Used by harness
# descriptors' synthetic/live capture checks.
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

echo "== [$HARNESS] tier A'': synthetic capture (deterministic, model-free) =="
if declare -F synthetic_capture_check >/dev/null; then synthetic_capture_check; else skip "no synthetic_capture_check"; fi

echo "== [$HARNESS] tier B: live capture (gated, model) =="
if declare -F live_capture_check >/dev/null; then live_capture_check; else skip "no live_capture_check"; fi

# Tier C — upstream CONTRACT (gated, network). For harnesses with no driveable
# CLI (a GUI IDE like Cursor), there is no tier-B live run to catch upstream
# drift, so the published contract (docs/spec) is the only external truth: this
# tier fetches it and asserts the event names / payload + output field names /
# config paths memorize hardcodes still appear. Optional + gated like tier B;
# turns a silent rename in the harness into a red check on the schedule.
echo "== [$HARNESS] tier C: upstream contract (gated, network) =="
if declare -F contract_check >/dev/null; then contract_check; else skip "no contract_check"; fi

echo "== [$HARNESS] summary: PASS=$PASS FAIL=$FAIL =="
[ "$FAIL" -eq 0 ]
