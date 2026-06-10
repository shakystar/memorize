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

# Preflight the global install directory. A stock Linux Node (installed to
# /usr/local or via the distro) makes `npm -g` root-owned, so the install
# below would die with a raw EACCES stack trace — and "re-run with sudo" is
# exactly what a curl|sh installer must not teach. Detect it up front and
# print the npm-recommended user-prefix fix instead.
npm_root=$(npm root -g 2>/dev/null || true)
if [ -n "$npm_root" ]; then
  check_dir=$npm_root
  while [ ! -d "$check_dir" ] && [ "$check_dir" != "/" ]; do
    check_dir=$(dirname "$check_dir")
  done
  if [ ! -w "$check_dir" ]; then
    echo "npm's global directory ($npm_root) is not writable by your user," >&2
    echo "so 'npm install -g' would fail with EACCES." >&2
    echo "" >&2
    echo "Fix it the npm-recommended way (no sudo needed):" >&2
    echo "    mkdir -p \"\$HOME/.npm-global\"" >&2
    echo "    npm config set prefix \"\$HOME/.npm-global\"" >&2
    echo "    export PATH=\"\$HOME/.npm-global/bin:\$PATH\"   # add this line to your shell profile too" >&2
    echo "" >&2
    echo "Then re-run this installer." >&2
    exit 1
  fi
fi

echo "Installing @shakystar/memorize globally..."
npm install -g @shakystar/memorize

if command -v memorize >/dev/null 2>&1; then
  memorize setup
else
  echo "memorize installed, but its command is not on PATH in this shell yet." >&2
  echo "Open a new terminal and run:  memorize setup" >&2
fi
