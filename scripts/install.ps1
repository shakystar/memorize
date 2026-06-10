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

# Parse `node -v` in PowerShell instead of `node -p '…split(".")…'`:
# Windows PowerShell 5.1 mangles the nested double quotes when passing the
# argument to node (native-arg quoting), so the -p form crashed and the
# check read 0 — the installer aborted on EVERY 5.1 shell despite a valid
# Node being present.
$nodeMajor = [int]((((node -v) -replace '^v', '') -split '\.')[0])
if ($nodeMajor -lt 22) {
  Write-Error "memorize requires Node.js >= 22 (found $(node -v)). Upgrade from https://nodejs.org then re-run."
  exit 1
}

Write-Host 'Installing @shakystar/memorize globally...'
npm install -g @shakystar/memorize

if (Get-Command memorize -ErrorAction SilentlyContinue) {
  memorize setup
} else {
  Write-Warning 'memorize installed, but its command is not on PATH in this shell yet.'
  Write-Warning 'Open a new terminal and run:  memorize setup'
}
