#!/usr/bin/env bash
#
# Memorize 30-second quickstart demo.
#
# This is the canonical demo sequence shown in the README. Designed to be
# played back via asciinema:
#
#     asciinema rec --command 'bash examples/quickstart.sh' demo.cast
#
# Defaults to running against the published npm package via npx so the
# recording matches what a brand-new user sees. Override MEMORIZE_BIN to
# run against a local checkout (e.g. for CI / regression testing the demo
# itself):
#
#     MEMORIZE_BIN="pnpm exec tsx src/cli/index.ts" bash examples/quickstart.sh
#
# The script is self-contained: it creates a throwaway temp directory,
# scopes the durable event log to that directory, and cleans up on exit
# so the demo never touches the user's real ~/.memorize state.

set -euo pipefail

MEMORIZE_BIN="${MEMORIZE_BIN:-npx @shakystar/memorize}"

DEMO_ROOT="$(mktemp -d -t memorize-quickstart-XXXXXX)"
export MEMORIZE_ROOT="${DEMO_ROOT}/.memorize-home"
PROJECT_DIR="${DEMO_ROOT}/login-service"
mkdir -p "${PROJECT_DIR}"
cd "${PROJECT_DIR}"

cleanup() {
  rm -rf "${DEMO_ROOT}"
}
trap cleanup EXIT

run() {
  printf '\n$ %s\n' "$*"
  eval "$@"
}

# A tiny AGENTS.md so `project setup` has something to import as a rule.
cat > AGENTS.md <<'AGENTS'
# login-service

- Keep auth tokens out of logs.
- Prefer integration tests over mocks for the auth path.
AGENTS

run "${MEMORIZE_BIN} project setup"

run "${MEMORIZE_BIN} task create \"Wire OAuth2 callback\""

run "${MEMORIZE_BIN} task list"

run "${MEMORIZE_BIN} task resume"

run "${MEMORIZE_BIN} task checkpoint --summary \"Skeleton routes scaffolded; tests still red.\""

printf '\n# Memorize is now tracking this project. Next session will see the\n'
printf '# task, the rule, and the checkpoint without you re-explaining.\n'
