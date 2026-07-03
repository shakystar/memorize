# AI_SETUP one-liner stress harness (Windows native).
# Each run gets a disposable fake HOME, isolated npm global prefix, scrubbed PATH
# (shims for node/npm/npx/git/claude/pnpm only), and an isolated CLAUDE_CONFIG_DIR
# seeded with credentials only. Leaks outside the sandbox (setx, real ~/.claude,
# real ~/.memorize, real npm global) are detected per run and recorded as findings.
#
# Self-test (no claude calls):  powershell -File run-stress.ps1 -Total 2 -SkipClaude
# Pilot:                        powershell -File run-stress.ps1 -Total 1
# Full mixed run:               powershell -File run-stress.ps1 -Total 100 -Mix mixed

param(
  [int]$Total = 100,
  [ValidateSet('mixed','base','matrix')][string]$Mix = 'mixed',
  [int]$StartAt = 1,
  [int]$TimeoutMin = 15,
  [int]$RateLimitWaitMin = 20,
  [int]$MaxRateLimitRetries = 6,
  [switch]$SkipClaude,
  [string]$ResultsRoot = ''
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
# Sandboxes MUST live outside the memorize repo: npm walks up from the project
# dir looking for a package root, and the repo root IS @shakystar/memorize, so
# npx would resolve to the local workspace instead of downloading from npm.
$stressRoot = Join-Path $env:LOCALAPPDATA 'memorize-stress'
if (-not $ResultsRoot) { $ResultsRoot = Join-Path $stressRoot 'results\win' }
$npmCache = Join-Path $stressRoot 'npm-cache'
$shims = Join-Path $stressRoot 'shims'
$verifyScript = Join-Path $root 'lib\verify.mjs'
$Prompt = 'Follow this guide to set up memorize in this project: https://github.com/shakystar/memorize/blob/main/guides/AI_SETUP.md'

New-Item -ItemType Directory -Force $ResultsRoot, $npmCache | Out-Null

# ---------- tool resolution & shims ----------

function Resolve-Tool([string[]]$candidates) {
  foreach ($c in $candidates) {
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
  }
  return $null
}

function New-Shim([string]$name, [string]$target) {
  $body = if ($target -match '\.(cmd|bat)$') { "@echo off`r`ncall `"$target`" %*" } else { "@echo off`r`n`"$target`" %*" }
  Set-Content -Path (Join-Path $shims "$name.cmd") -Value $body -Encoding ascii
}

if (Test-Path $shims) { Remove-Item -Recurse -Force $shims }
New-Item -ItemType Directory -Force $shims | Out-Null

$tools = @{
  node   = Resolve-Tool @('node.exe','node')
  npm    = Resolve-Tool @('npm.cmd','npm')
  npx    = Resolve-Tool @('npx.cmd','npx')
  git    = Resolve-Tool @('git.exe','git')
  claude = Resolve-Tool @('claude.exe','claude.cmd','claude')
  pnpm   = Resolve-Tool @('pnpm.cmd','pnpm.exe','pnpm')
}
$required = @('node','npm','npx','git') + $(if (-not $SkipClaude) { @('claude') } else { @() })
foreach ($k in $required) {
  if (-not $tools[$k]) { throw "required tool not found on host PATH: $k" }
}
foreach ($k in $tools.Keys) {
  if ($tools[$k]) {
    $t = $tools[$k]
    if ($t -match '\.ps1$') { $t = $t -replace '\.ps1$', '.cmd' }  # npm wrappers: prefer .cmd
    New-Shim $k $t
  }
}
$hasPnpm = [bool]$tools.pnpm

# ---------- claude credentials ----------

$realCfg = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }
$credFile = Join-Path $realCfg '.credentials.json'
if (-not $SkipClaude -and -not (Test-Path $credFile)) {
  throw "claude credentials not found at $credFile - run 'claude' once and log in, or set CLAUDE_CONFIG_DIR"
}

# ---------- sandbox env ----------

$sys32 = "$env:SystemRoot\System32"
function New-SandboxEnv([string]$runDir) {
  $home_ = Join-Path $runDir 'home'
  $prefix = Join-Path $runDir 'prefix'
  @{
    SystemRoot = $env:SystemRoot; windir = $env:SystemRoot
    ComSpec = "$sys32\cmd.exe"
    PATHEXT = '.COM;.EXE;.BAT;.CMD'
    SystemDrive = $env:SystemDrive
    OS = 'Windows_NT'
    NUMBER_OF_PROCESSORS = $env:NUMBER_OF_PROCESSORS
    PROCESSOR_ARCHITECTURE = $env:PROCESSOR_ARCHITECTURE
    USERNAME = $env:USERNAME
    USERPROFILE = $home_; HOME = $home_
    HOMEDRIVE = ($home_ -split ':')[0] + ':'
    HOMEPATH = ($home_ -replace '^[A-Za-z]:','')
    APPDATA = Join-Path $home_ 'AppData\Roaming'
    LOCALAPPDATA = Join-Path $home_ 'AppData\Local'
    TEMP = Join-Path $runDir 'tmp'; TMP = Join-Path $runDir 'tmp'
    CLAUDE_CONFIG_DIR = Join-Path $runDir 'claude-config'
    npm_config_prefix = $prefix
    npm_config_cache = $npmCache
    npm_config_update_notifier = 'false'
    DISABLE_AUTOUPDATER = '1'
    PATH = "$shims;$prefix;$prefix\bin;$sys32;$env:SystemRoot;$sys32\WindowsPowerShell\v1.0"
  }
}

# Run a command line inside the sandbox env via a generated .cmd wrapper.
# Returns @{ exit; timedOut; durationSec }
function Invoke-Sandboxed([string]$runDir, [hashtable]$envMap, [string]$cwd, [string]$cmdLine,
                          [int]$timeoutSec, [string]$outFile, [string]$errFile) {
  $script = Join-Path $runDir '_invoke.cmd'
  Set-Content -Path $script -Encoding ascii -Value @(
    '@echo off',
    "$cmdLine > `"$outFile`" 2> `"$errFile`"",
    'exit /b %ERRORLEVEL%'
  )
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "$sys32\cmd.exe"
  $psi.Arguments = "/d /c `"`"$script`"`""
  $psi.WorkingDirectory = $cwd
  $psi.UseShellExecute = $false
  $psi.EnvironmentVariables.Clear()
  foreach ($k in $envMap.Keys) { $psi.EnvironmentVariables[$k] = [string]$envMap[$k] }
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $p = [System.Diagnostics.Process]::Start($psi)
  $timedOut = $false
  if (-not $p.WaitForExit($timeoutSec * 1000)) {
    $timedOut = $true
    try { & "$sys32\cmd.exe" /d /c "taskkill /T /F /PID $($p.Id) >nul 2>&1" } catch {}
    $p.WaitForExit()
  }
  $sw.Stop()
  @{ exit = $(if ($timedOut) { -1 } else { $p.ExitCode }); timedOut = $timedOut; durationSec = [math]::Round($sw.Elapsed.TotalSeconds, 1) }
}

# ---------- fixtures ----------

function New-Fixture([string]$scenario, [string]$proj) {
  New-Item -ItemType Directory -Force $proj | Out-Null
  Set-Content (Join-Path $proj 'README.md') "# stress fixture ($scenario)`n"
  switch ($scenario) {
    'node-basic' {
      Set-Content (Join-Path $proj 'package.json') '{ "name": "stress-fixture", "version": "1.0.0", "private": true }'
      Set-Content (Join-Path $proj 'index.js') 'console.log("hi");'
    }
    'non-node' {
      New-Item -ItemType Directory -Force (Join-Path $proj 'src') | Out-Null
      Set-Content (Join-Path $proj 'src\main.py') 'print("hi")'
    }
    'pnpm-monorepo' {
      Set-Content (Join-Path $proj 'package.json') '{ "name": "stress-root", "version": "1.0.0", "private": true }'
      Set-Content (Join-Path $proj 'pnpm-workspace.yaml') "packages:`n  - packages/*"
      New-Item -ItemType Directory -Force (Join-Path $proj 'packages\app') | Out-Null
      Set-Content (Join-Path $proj 'packages\app\package.json') '{ "name": "app", "version": "1.0.0", "private": true }'
    }
    'existing-docs' {
      Set-Content (Join-Path $proj 'package.json') '{ "name": "stress-fixture", "version": "1.0.0", "private": true }'
      Set-Content (Join-Path $proj 'index.js') 'console.log("hi");'
      Set-Content (Join-Path $proj 'CLAUDE.md') "# Project rules`n`n- Always write tests first.`n- API responses use snake_case.`n"
      Set-Content (Join-Path $proj '.cursorrules') "Prefer small functions. Never commit secrets.`n"
    }
  }
  $g = $tools.git
  & $g -C $proj init -q
  & $g -C $proj -c user.name=stress -c user.email=stress@test.local add -A
  & $g -C $proj -c user.name=stress -c user.email=stress@test.local commit -q -m 'fixture' | Out-Null
}

# ---------- leak detection ----------

function Get-FileHashOrAbsent([string]$p) {
  if (Test-Path $p) { (Get-FileHash -Algorithm SHA256 $p).Hash } else { 'absent' }
}

function Get-LeakState {
  $userEnv = [Environment]::GetEnvironmentVariables('User')
  $envPairs = @($userEnv.Keys | Sort-Object | ForEach-Object { "$_=$($userEnv[$_])" })
  $realHome = $env:USERPROFILE
  @{
    userEnv = $envPairs
    claudeSettings = Get-FileHashOrAbsent (Join-Path $realCfg 'settings.json')
    codexHooks = Get-FileHashOrAbsent (Join-Path $realHome '.codex\hooks.json')
    memorizeDir = @(if (Test-Path (Join-Path $realHome '.memorize')) { (Get-ChildItem (Join-Path $realHome '.memorize') -Name | Sort-Object) } else { @('absent') })
  }
}

function Compare-LeakState($before, $after) {
  $leaks = @()
  $gained = @($after.userEnv | Where-Object { $before.userEnv -notcontains $_ })
  $lost = @($before.userEnv | Where-Object { $after.userEnv -notcontains $_ })
  if ($gained -or $lost) {
    $leaks += @{ kind = 'userEnv'; gained = $gained; lost = $lost }
    # revert vars the agent set (e.g. setx MEMORIZE_LLM_BACKEND ...): new -> delete, modified -> restore old value
    foreach ($pair in $gained) {
      $name = ($pair -split '=', 2)[0]
      $old = $lost | Where-Object { $_ -like "$name=*" } | Select-Object -First 1
      if ($old) { [Environment]::SetEnvironmentVariable($name, ($old -split '=', 2)[1], 'User') }
      else { [Environment]::SetEnvironmentVariable($name, $null, 'User') }
      $leaks += @{ kind = 'userEnvReverted'; name = $name; restored = [bool]$old }
    }
  }
  foreach ($k in @('claudeSettings','codexHooks')) {
    if ($before[$k] -ne $after[$k]) { $leaks += @{ kind = $k; before = $before[$k]; after = $after[$k] } }
  }
  $memGained = @($after.memorizeDir | Where-Object { $before.memorizeDir -notcontains $_ })
  if ($memGained) { $leaks += @{ kind = 'realMemorizeStore'; gained = $memGained } }
  ,$leaks
}

# ---------- manifest ----------

$matrixPool = @('non-node','existing-docs') + $(if ($hasPnpm) { @('pnpm-monorepo') } else { @() })
if (-not $hasPnpm) { Write-Warning 'pnpm not found on host - pnpm-monorepo scenario excluded from matrix' }
$manifest = @(for ($i = 1; $i -le $Total; $i++) {
  switch ($Mix) {
    'base'   { 'node-basic' }
    'matrix' { $matrixPool[($i - 1) % $matrixPool.Count] }
    'mixed'  { if ($i -le [math]::Ceiling($Total / 2)) { 'node-basic' } else { $matrixPool[($i - 1) % $matrixPool.Count] } }
  }
})

# ---------- main loop ----------

Write-Host "== setup-stress: $Total runs (mix=$Mix), results -> $ResultsRoot"

for ($i = $StartAt; $i -le $Total; $i++) {
  $scenario = $manifest[$i - 1]
  $runId = 'run-{0:d3}' -f $i
  $runDir = Join-Path $ResultsRoot $runId
  if (Test-Path (Join-Path $runDir 'meta.json')) { Write-Host "$runId already done, skipping"; continue }
  if (Test-Path $runDir) { Remove-Item -Recurse -Force $runDir }

  $home_ = Join-Path $runDir 'home'
  $proj = Join-Path $runDir 'project'
  $cfg = Join-Path $runDir 'claude-config'
  foreach ($d in @($home_, (Join-Path $home_ 'AppData\Roaming'), (Join-Path $home_ 'AppData\Local'),
                   $proj, $cfg, (Join-Path $runDir 'prefix'), (Join-Path $runDir 'tmp'))) {
    New-Item -ItemType Directory -Force $d | Out-Null
  }
  Set-Content (Join-Path $home_ '.gitconfig') "[user]`n`tname = stress`n`temail = stress@test.local`n[init]`n`tdefaultBranch = main`n"
  if (Test-Path $credFile) { Copy-Item $credFile (Join-Path $cfg '.credentials.json') }
  Set-Content (Join-Path $cfg '.claude.json') '{ "hasCompletedOnboarding": true, "bypassPermissionsModeAccepted": true }'
  Set-Content (Join-Path $cfg 'settings.json') '{}'
  New-Fixture $scenario $proj

  $envMap = New-SandboxEnv $runDir

  # preflight: memorize must NOT resolve inside the sandbox; node must resolve
  $pf1 = Invoke-Sandboxed $runDir $envMap $proj 'where memorize' 30 (Join-Path $runDir 'pf-memorize.txt') (Join-Path $runDir 'pf-memorize.err')
  $pf2 = Invoke-Sandboxed $runDir $envMap $proj 'node --version' 30 (Join-Path $runDir 'pf-node.txt') (Join-Path $runDir 'pf-node.err')
  if ($pf1.exit -eq 0) { throw "$runId preflight failed: memorize resolvable inside sandbox (PATH leak)" }
  if ($pf2.exit -ne 0) { throw "$runId preflight failed: node not resolvable inside sandbox" }

  $leakBefore = Get-LeakState
  $started = Get-Date
  $claudeRes = @{ exit = $null; timedOut = $false; durationSec = 0 }
  $rateRetries = 0

  if (-not $SkipClaude) {
    while ($true) {
      Write-Host ("[{0}] {1} scenario={2} claude -p ..." -f (Get-Date -Format 'HH:mm:ss'), $runId, $scenario)
      $claudeRes = Invoke-Sandboxed $runDir $envMap $proj `
        "claude -p `"$Prompt`" --output-format stream-json --verbose --dangerously-skip-permissions" `
        ($TimeoutMin * 60) (Join-Path $runDir 'stdout.ndjson') (Join-Path $runDir 'stderr.txt')
      $tail = ''
      foreach ($f in @('stdout.ndjson','stderr.txt')) {
        $p = Join-Path $runDir $f
        if (Test-Path $p) { $tail += ((Get-Content $p -Tail 30 -ErrorAction SilentlyContinue) -join "`n") }
      }
      if ($claudeRes.exit -ne 0 -and $tail -match 'usage limit|rate limit|overloaded|429' -and $rateRetries -lt $MaxRateLimitRetries) {
        $rateRetries++
        Write-Warning "$runId hit rate limit, waiting $RateLimitWaitMin min (retry $rateRetries/$MaxRateLimitRetries)"
        Start-Sleep -Seconds ($RateLimitWaitMin * 60)
        continue
      }
      break
    }
  }

  $verifyRes = Invoke-Sandboxed $runDir $envMap $proj "node `"$verifyScript`" `"$proj`"" 600 (Join-Path $runDir 'verify.json') (Join-Path $runDir 'verify.err')
  $leakAfter = Get-LeakState
  $leaks = Compare-LeakState $leakBefore $leakAfter
  Set-Content (Join-Path $runDir 'leak.json') (ConvertTo-Json @{ leaks = $leaks } -Depth 6)

  $meta = @{
    runId = $runId; scenario = $scenario; platform = 'win'; skipClaude = [bool]$SkipClaude
    startedAt = $started.ToString('o'); prompt = $Prompt
    claudeExit = $claudeRes.exit; claudeTimedOut = $claudeRes.timedOut; claudeDurationSec = $claudeRes.durationSec
    verifyExit = $verifyRes.exit; rateLimitRetries = $rateRetries; leakCount = $leaks.Count
  }
  Set-Content (Join-Path $runDir 'meta.json') (ConvertTo-Json $meta -Depth 4)

  $vTag = if ($verifyRes.exit -eq 0) { 'VERIFY-OK' } else { 'VERIFY-FAIL' }
  $lTag = if ($leaks.Count -gt 0) { " LEAKS=$($leaks.Count)" } else { '' }
  Write-Host ("[{0}] {1} done: claude exit={2} ({3}s) {4}{5}" -f (Get-Date -Format 'HH:mm:ss'), $runId, $claudeRes.exit, $claudeRes.durationSec, $vTag, $lTag)
}

Write-Host "== all runs complete. Aggregate with: node aggregate.mjs `"$ResultsRoot`""
