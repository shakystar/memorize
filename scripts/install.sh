#!/usr/bin/env sh
# Memorize one-line installer (POSIX: Linux / macOS / WSL).
#
# Thin bootstrapper. It only ensures Node + npm are present, installs the
# global binary, and hands off to `memorize setup`, which performs all
# agent detection and wiring. Keep logic out of this file.
set -e

if ! command -v node >/dev/null 2>&1; then
  echo "memorize requires Node.js >= 22. Install it from https://nodejs.org then re-run." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "memorize requires npm (bundled with Node.js >= 22). Install Node.js from https://nodejs.org then re-run." >&2
  exit 1
fi

node_major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$node_major" -lt 22 ]; then
  echo "memorize requires Node.js >= 22 (found $(node -v)). Upgrade from https://nodejs.org then re-run." >&2
  exit 1
fi

echo "Installing @shakystar/memorize globally..."
npm install -g @shakystar/memorize

if command -v memorize >/dev/null 2>&1; then
  memorize setup
else
  echo "memorize installed, but its command is not on PATH in this shell yet." >&2
  echo "Open a new terminal and run:  memorize setup" >&2
fi
