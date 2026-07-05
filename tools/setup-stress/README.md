# setup-stress: AI_SETUP one-liner stress harness

Repeatedly runs the real user one-liner —

> `claude -p "Follow this guide to set up memorize in this project: https://github.com/shakystar/memorize/blob/main/guides/AI_SETUP.md"`

— inside a disposable sandbox that looks like a machine that has never
seen memorize, then verifies the outcome deterministically and detects
any writes that escaped the sandbox.

## Isolation model (per run)

| Axis | Mechanism |
| --- | --- |
| Home (`~/.memorize`, `~/.codex`) | fake `HOME`/`USERPROFILE` (+ `APPDATA`/`LOCALAPPDATA` on Windows) |
| npm global installs | `npm_config_prefix` → per-run dir; shared `npm_config_cache` for speed |
| PATH | shim dir exposing ONLY node/npm/npx/git/claude/pnpm; preflight asserts `memorize` does NOT resolve |
| Claude config | `CLAUDE_CONFIG_DIR` → per-run dir seeded with `.credentials.json` only (no personal hooks/plugins) |
| Leaks | before/after snapshot of real `~/.claude/settings.json`, `~/.codex/hooks.json`, real `~/.memorize`, and (Windows) User registry env vars (`setx` catcher, auto-reverted) |

A leak is recorded as a finding, not just noise — the guide must never
mutate state outside the project + home.

## Scenarios

- `node-basic` — package.json project (also the flaky-rate baseline)
- `non-node` — no package.json (global-install path)
- `pnpm-monorepo` — workspace root (`ERR_PNPM_ADDING_TO_ROOT` path; skipped if host has no pnpm)
- `existing-docs` — pre-existing CLAUDE.md / .cursorrules (import path)

`-Mix mixed` (default): first half `node-basic` (measures nondeterministic
failure rate), second half cycles the matrix.

## Usage

Prereqs: node ≥ 22.9, git, claude CLI logged in (subscription OAuth). The
inner session runs with `--dangerously-skip-permissions` inside the sandbox.

Windows (PowerShell):

```powershell
# harness self-test, no claude calls (verify is EXPECTED to fail):
powershell -ExecutionPolicy Bypass -File run-stress.ps1 -Total 1 -SkipClaude
# pilot:
powershell -ExecutionPolicy Bypass -File run-stress.ps1 -Total 3
# full:
powershell -ExecutionPolicy Bypass -File run-stress.ps1 -Total 100 -Mix mixed
```

WSL (run from a WSL shell; sandboxes live on the Linux fs at `~/memorize-stress/`):

```bash
bash /mnt/c/dev/active/memorize/tools/setup-stress/run-stress.sh --total 1 --skip-claude
bash /mnt/c/dev/active/memorize/tools/setup-stress/run-stress.sh --total 100 --mix mixed
```

Sandboxes/results deliberately live OUTSIDE the repo (`%LOCALAPPDATA%\memorize-stress`
on Windows, `~/memorize-stress` in WSL): npm walks up from the project dir looking
for a package root, and this repo root IS `@shakystar/memorize`, so an in-repo
sandbox makes npx resolve to the local workspace instead of the npm registry.

Aggregate (both platforms at once):

```powershell
node aggregate.mjs "$env:LOCALAPPDATA\memorize-stress\results\win" "\\wsl$\Ubuntu\home\<user>\memorize-stress\results"
```

Runs are resumable: a run dir with `meta.json` is skipped, so re-running
the same command continues where it stopped (or use `-StartAt`).

## Per-run outputs (`results/<platform>/run-NNN/`)

- `stdout.ndjson` — full inner-session transcript (`stream-json`)
- `verify.json` — deterministic checks: doctor ok, bin resolvable, Claude
  hooks in `.claude/settings.local.json`, `.gitignore` entry, project
  bound, store in (fake) home
- `leak.json` / `leak.diff` — sandbox escapes
- `meta.json` — scenario, exit code, duration, timeout, rate-limit retries

## Notes / limits

- Serial by design: 100 runs ≈ 4–8 h. Runs share the subscription rate
  limit; on a limit error the runner sleeps (`-RateLimitWaitMin`, default
  20 min) and retries the same run.
- Timeout per run: `-TimeoutMin` (default 15). Timed-out inner sessions
  are killed as a process tree and bucketed as `claude-timeout`.
- Not yet covered: WSL-shadow scenario (Windows memorize leaking through
  `/mnt/c` PATH interop) — see the pitfalls list before wiring it in.
