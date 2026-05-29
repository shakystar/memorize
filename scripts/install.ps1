# Memorize one-line installer (Windows PowerShell).
#
# Thin bootstrapper. It only ensures Node + npm are present, installs the
# global binary, and hands off to `memorize setup`, which performs all
# agent detection and wiring. Keep logic out of this file.
$ErrorActionPreference = 'Stop'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error 'memorize requires Node.js >= 22. Install it from https://nodejs.org then re-run.'
  exit 1
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Error 'memorize requires npm (bundled with Node.js >= 22). Install Node.js from https://nodejs.org then re-run.'
  exit 1
}

$nodeMajor = [int](node -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt 22) {
  Write-Error "memorize requires Node.js >= 22 (found $(node -v)). Upgrade from https://nodejs.org then re-run."
  exit 1
}

Write-Host 'Installing @shakystar/memorize globally...'
npm install -g @shakystar/memorize

memorize setup
