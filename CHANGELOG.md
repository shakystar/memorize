# Changelog

All notable changes to `@shakystar/memorize` are recorded here.

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
loosely. The project adheres to [Semantic Versioning](https://semver.org/);
major-version bumps are reserved for breaking changes to the on-disk event
log layout or the public CLI surface.

## [1.0.0] — 2026-05-06

First stable release. The 1.0 cut closes the rc.5..rc.12 alpha
stabilization series and establishes the data, lifecycle, and
attribution invariants the project is willing to support
indefinitely. No new features over rc.12 — this is a repackaging.

### What 1.0 commits to

- **Per-cwd multi-session.** Multiple agent sessions in the same
  directory at the same time are a first-class case. Each
  SessionStart claims a distinct task atomically (file lock); the
  picker hides heartbeat-stale sessions from view but never
  silently mutates their on-disk status.
- **"1 agent conversation = 1 memorize session" across resume.**
  Both Claude (`claude --resume`) and codex (`codex resume`)
  preserve their session UUID, and memorize stamps that UUID on
  the cwd pointer at SessionStart so the resume path reattaches
  to the same memorize session instead of minting a new one. The
  Model C lifecycle (rc.12) keeps the cwd pointer alive across
  SessionEnd by transitioning the session to `paused` rather
  than deleting the pointer; resume flips it back to `active`.
- **Single resolver for "which session am I?"** Every CLI command
  and hook handler that asks "which memorize session is calling
  me?" goes through `resolveSessionContext` (the SSoT, rc.8).
  The priority chain is the same everywhere: env
  (`MEMORIZE_SESSION_ID`) → agent-native env
  (`CODEX_THREAD_ID`, rc.11) → process-tree agent-pid →
  tty → opt-in most-recent. No code path rolls its own.
- **Heartbeat-driven liveness, explicit reap.** A pointer's
  `lastSeenAt` is bumped by every memorize CLI call; the picker
  filter and the reap sweep both consult it. The only mutator of
  session status is `memorize session reap`. Auto-reap on
  startSession was removed in the alpha series and is not coming
  back: long-lived role sessions need their pointer to survive
  unrelated session starts.
- **Append-only event log + projection rebuild.** Domain state
  changes go through events; projections are rebuilt from the log
  on every write. There is no in-place mutation of projected
  records. `session.paused` joins the existing `session.started`
  / `session.resumed` / `session.completed` / `session.abandoned`
  / `session.heartbeat` set.

### Known platform asymmetries (intentional, documented)

- **Codex has no SessionEnd hook.** Its registered hook surface is
  SessionStart / PreToolUse / PostToolUse / UserPromptSubmit /
  Stop. Codex sessions therefore skip the `paused` transition
  entirely — they stay `active` until heartbeat-stale, then the
  next reap sweep marks them `abandoned`. Picker hides them via
  heartbeat staleness in the meantime, so the asymmetry is
  invisible to attribution and to the picker. Listed here so an
  inspector who reads the projection isn't surprised that two
  agents leave different artifacts behind on a clean exit.
- **`memorize task handoff --help` is unconventional.** The flag
  parser treats `--help` as a value-bearing flag and errors
  rather than printing usage. Codex agents recover by trial; no
  data correctness impact. Tracked for a 1.0.x patch.

### Diagnostic surface

- `MEMORIZE_DEBUG=1` causes every labeled call to
  `resolveSessionContext` / `resolveByAgentSessionId` to emit one
  stderr line tagged `label=… via=… session=… task=… actor=…
  agentPid=… agentSession=… ppid=… walked=[…] pointerPids=[…]`.
  Off by default — zero overhead in normal operation. This was
  what made the rc.10 → rc.11 codex resolver hole diagnosable in
  one round of dogfood; keep it in for the next surprise.

### Tests

201 tests across 42 files, all green. The suite covers: resolver
priority chain (env / agent-env / agent-pid / tty / most-recent /
none), file-lock serialization (race regression for picker
deconfliction), Model C pause→resume cycle, agent-pid debug
emit, install/doctor/handoff/checkpoint paths, and the cumulative
β session-lifecycle redesign.

## [1.0.0-rc.12] — 2026-05-06

### Changed — session lifecycle: end is now pause-by-default (Model C)

The Claude SessionEnd hook used to mark the session `completed` and
unlink the cwd pointer. That broke `claude --resume` for the same
session: the resume's SessionStart fires with the same agent UUID,
but `resolveByAgentSessionId` walks cwd pointers — and the pointer
was gone. The resume path silently fell back to minting a new
memorize session, breaking the "1 agent conversation = 1 memorize
session" invariant the SessionStart resume detection was supposed
to preserve.

Lifecycle is now explicit:

- New status `paused` between `active` and `completed`/`abandoned`.
  `paused` keeps the cwd pointer and the projection record on
  disk; the picker treats `paused` exactly like `active` (still
  claims its task, still subject to heartbeat staleness).
- New event `session.paused` with its own projector case.
- New `pauseSession()` service function. SessionEnd hook now calls
  `pauseSession` instead of `endSession`. The pointer survives,
  resume reattaches via existing `resolveByAgentSessionId` →
  `resumeSession()` path, and the projector flips `paused` back
  to `active` on the `session.resumed` event.
- Reap sweep picks up paused-and-stale sessions on the same
  threshold as active-and-stale ones — `paused` is "agent went to
  bed", `abandoned` is "agent never came back". `endSession` is
  still in code for an eventual explicit `memorize session end`
  CLI but no hook calls it now.
- Codex has no SessionEnd event at all (its hook surface is
  SessionStart / PreToolUse / PostToolUse / UserPromptSubmit /
  Stop). Codex sessions therefore skip pause and rely on the same
  reap path, which is fine: `paused` and `active` are equivalent
  for picker and reap, so the asymmetry has no observable effect.

### Fixed — resume returns the previously-claimed task

The SessionStart resume path called `composeStartupContext` with
only `selfSessionId` set. The picker excluded the just-resumed
session from its own view and then returned whatever
unclaimed-or-other task happened to surface — not the task the
session previously claimed. Round-6 dry-fire reproduced this:
codex session resume returned the claude session's task in the
hook's `additionalContext`. `composeStartupContext` now accepts
an explicit `taskId` and the resume path passes the resumed
pointer's `taskId`; the explicit CLI `runResumeTask` already
worked this way (rc.9), so this brings the hook path to parity.

### Tests

- `tests/integration/claude-hook-lifecycle.test.ts` — two existing
  SessionEnd tests rewritten to assert pointer survival +
  `session.paused` + projection status `paused` (was: pointer
  unlinked + `session.completed`). One new end-to-end test pins
  the full pause→resume cycle: same memorize session id is
  preserved, status flips paused→active, no second pointer
  minted.
- `tests/integration/task-aware-hooks.test.ts` — same SessionEnd
  test rewrite.

### Tests count: 200 → 201

## [1.0.0-rc.11] — 2026-05-06

### Fixed — codex `task resume` returns the wrong task on macOS

Round-5 dogfood, with the rc.10 instrumentation: codex `task resume`
emitted `via=none walked=[1727,90450,90373,90372,415]
pointerPids=[…,99604]`. The walked ancestor chain bottomed out at
launchd before reaching codex's pid (99604), even though codex was
the agent that started the subprocess. The Claude/codex shell tool
worker subsystems detach their workers and the OS reparents them
to launchd, so a CLI subprocess walking up `process.ppid` never
encounters the agent root pid. The agent-pid path is structurally
broken on macOS for both agents — Claude was only working because
of the parallel `MEMORIZE_SESSION_ID` env injection via
`CLAUDE_ENV_FILE`. Codex had no equivalent injection, so it fell
all the way through to `none` and the picker returned the first
project todo.

`env | grep -i codex` inside a codex subprocess revealed
`CODEX_THREAD_ID=<codex session UUID>` propagates natively. We
already stamp that same UUID as `agentSessionId` on the cwd
pointer at SessionStart, so a one-line resolver path closes the
hole:

- New resolution path `agent-env`, slotted between our own `env`
  and the (now defensive) `agent-pid`. Reads `CODEX_THREAD_ID`,
  matches against `agentSessionId` on cwd pointers. Returns
  `none` on miss rather than silently picking an unrelated codex
  pointer — the priority chain stays exact.
- Belt-and-suspenders precedence: when both `MEMORIZE_SESSION_ID`
  and `CODEX_THREAD_ID` are set, our explicit injection still
  wins. The codex env path is the codex-only fallback for the
  case where our injection never happened.

Verified directly: `CODEX_THREAD_ID=<uuid> memorize task resume`
in the duo-pane sandbox now returns `via=agent-env session=…
task=task_moplj40r_oi7j35wh actor=codex` instead of `via=none`
+ first-todo. Round-6 dogfood will pin it inside a real codex
session.

### Added — diagnostic refinements

- Debug emit now includes `walked=[…]` (the ancestor pid chain
  the resolver actually walked) and `pointerPids=[…]` (the set
  of `agentPid` values stamped on cwd pointers in this cwd).
  These two fields are what made the macOS reparenting cause
  diagnosable in one line — keep them in for the next surprise.

### Tests

- 3 new cases in `tests/unit/session-context.test.ts` for
  `agent-env`: resolves codex pointer when `CODEX_THREAD_ID`
  matches; our `MEMORIZE_SESSION_ID` env wins when both are
  set; non-matching `CODEX_THREAD_ID` falls through to `none`
  (no silent wrong attribution to an unrelated codex pointer).

### Tests count: 197 → 200

## [1.0.0-rc.10] — 2026-05-06

### Added — diagnostic-only, no behavior change

- **`MEMORIZE_DEBUG=1` resolver instrumentation.** Round-4 dogfood found
  codex `task resume` returning the first project todo instead of the
  calling session's claimed task, while same-session `task handoff`
  attributed correctly. Both paths use `resolveSessionContext`, so the
  divergence had to be inside the resolver — but with no per-call-site
  visibility we couldn't tell which branch (env / agent-pid / tty /
  none) `task resume` actually hit. With `MEMORIZE_DEBUG=1` set, every
  resolver call from a labeled call site now emits one stderr line:

  ```
  [memorize-debug] resolve label=task-resume via=none session=- task=- actor=- agentPid=- agentSession=- ppid=12345
  ```

  Labels wired in: `task-resume`, `task-handoff`, `task-checkpoint`
  (CLI), `hook-session-start-resume`, `hook-post-compact`,
  `hook-session-end` (hooks). Unlabeled calls stay silent. Off when
  the env var is unset — no overhead in normal operation.

  Local smoke run from a non-session shell already reproduced the
  bug pattern: `via=none` → picker falls back to first todo
  (`task_mos7v3iw`, exactly the task codex was reporting). Round-5
  dogfood will surface whether codex's `task resume` subprocess hits
  the same branch (env propagation gap) or a different one (process
  tree depth, lazy SessionStart timing).

### Tests

- `tests/unit/session-context.test.ts` — 4 new cases for the debug
  emit: silent when `MEMORIZE_DEBUG` unset, silent when no label,
  one tagged line when both set, `via=none` for misses so we can
  tell "no pointer" from "wrong pointer".

### Tests count: 193 → 197

## [1.0.0-rc.9] — 2026-05-05

### Fixed (rc.7 round-2 dogfood follow-ups, plus rc.8 round-3 finding)

- **Picker race — atomic SessionStart claim.** Two SessionStart hooks
  firing within ms of each other in the same project (round-2 dogfood:
  32ms gap) both saw the same active set in their picker view, so
  both newly-started sessions claimed the same task. The pick-then-
  claim window is now serialized per project via a tiny file lock
  (`<project_root>/locks/session-start.lock`, O_EXCL create with
  retry-and-stale-reclaim). Resume path skips the lock — only fresh
  claims need it.
- **`memorize task resume` is session-aware.** Round-3 codex session
  noticed `task resume` showed the project's first active task
  instead of the calling session's claimed task — the same Gap A
  pattern handoff/checkpoint had before rc.7. Now uses
  `resolveSessionContext` to thread the calling session's `taskId`
  and `selfSessionId` into `loadStartContext`.

### Added

- **`storage/file-lock.ts` — `withFileLock(lockDir, name, body, opts)`.**
  Generic per-project advisory lock primitive built on O_EXCL create.
  Holds for the duration of `body`, removes on completion (even on
  throw), reclaims stale locks past `holdTimeoutMs` (default 5s) so
  a crashed holder can't deadlock future entries.

### Tests

- `tests/unit/file-lock.test.ts` — 4 cases pinning the lock contract:
  body runs and lock is removed; lock is removed on throw; concurrent
  acquirers serialize (B's enter follows A's exit); stale lock is
  force-reclaimed past `holdTimeoutMs`.
- `tests/integration/picker-deconflict.test.ts` — new race regression
  test fires 4 SessionStart hooks in parallel and pins that each
  ends up with a distinct claimed task. Without the lock this fails
  repeatably.

### Tests count: 188 → 193

## [1.0.0-rc.8] — 2026-05-05

### ADR-1: single source of truth for session resolution

The rc.4 → rc.7 series fixed Gap A in three different code paths,
each with its own slightly different env → tty → most-recent fallback
chain. The 4-session round-2 dogfood showed that per-path duplication
hadn't actually closed the hole — codex CLI subprocesses still
attributed to `actor: user` against the wrong `taskId` because the
CLI command's chain lacked an agent-pid hop. The pattern was on its
way to becoming spaghetti: every new agent quirk meant another
fallback in another caller.

- **New `services/session-context.ts` is the only resolver of "which
  session am I?".** Exposes `resolveSessionContext(cwd, { allowMostRecent })`
  and `resolveByAgentSessionId(cwd, agentId)`. Returns
  `ResolvedSessionContext` with `sessionId`, `taskId`, `actor`,
  `projectId`, `agentSessionId`, `agentPid`, and a `resolvedVia` field
  (`'env' | 'agent-pid' | 'tty' | 'most-recent' | 'none'`) so the
  resolution path is observable when an attribution looks wrong.
- **New `storage/cwd-session-store.ts`** owns the `CwdSessionPointer`
  type and all pointer file I/O (read / write / list / delete /
  legacy migration). Both `services/session-service` (lifecycle) and
  `services/session-context` (resolution) read through this single
  storage module — no more file paths scattered across services.
- **All callers migrated.** `runHandoffTask`, `runCheckpointTask`,
  `handlePostCompact`, `handleSessionEnd`, `bumpHeartbeat`,
  `endSession`, `getCurrentSessionId`, the wrappers — every
  identity-resolving call now goes through the SSoT.

### Fixed (rc.7 dogfood — codex CLI env propagation hole)

The new resolver adds an **agent-pid match** path the per-caller
chains were missing. SessionStart already stamped the host agent's
pid on the cwd pointer (rc.6); rc.8 walks up `process.ppid` in the
CLI subprocess and looks for a pointer whose `agentPid` is in that
chain. This is the only reliable identity path for codex (codex has
no `CLAUDE_ENV_FILE` equivalent, so `MEMORIZE_SESSION_ID` never
reaches its Bash subprocesses, so env-fallback always missed).
Priority: `env` (fast, exact) → `agent-pid` (slower, exact, the new
hop) → `tty` (best-effort) → opt-in `most-recent`.

The rc.7 fix to `runHandoffTask` / `runCheckpointTask` stays in
place — those handlers now ask `resolveSessionContext` directly
instead of running their own short fallback chain, so the agent-pid
hop reaches them automatically.

### Tests

- New `tests/unit/session-context.test.ts` — 6 cases pinning each
  resolution path: `none` when no pointers, `env` exact match,
  `agent-pid` ancestor walk match (planted with `process.ppid`),
  env-wins-over-agent-pid priority, default refusal of most-recent
  fallback, opt-in most-recent fallback.
- All 182 prior tests still pass — refactor was behavior-preserving
  for the existing surface; the codex hole closes via the new
  agent-pid path.

### Removed

- `findCwdSessionByAgentId` (was a private helper in session-service)
  superseded by `resolveByAgentSessionId` from session-context.
- The duplicated env → tty → most-recent fallback in
  `findCwdSession`, `runHandoffTask`, `runCheckpointTask`,
  `handlePostCompact`. All now delegate to `resolveSessionContext`.

## [1.0.0-rc.7] — 2026-05-05

### Fixed (rc.6 dogfood — Gap A leak at the CLI surface)

The first 4-session mixed dogfood (2 Claude + 2 Codex in one cwd)
exposed that the rc.4 Gap A fix only landed inside the hook handlers
(`PostCompact`, etc.) — `memorize task handoff` and `memorize task
checkpoint` invoked from inside an agent's Bash subprocess kept
falling back to `project.activeTaskIds[0]` and `ACTOR_USER`. Result:
both codex sessions' handoffs attached to whichever task happened to
be first in the project's active list (always the same `task_moplj3xs`
in the dogfood fixture), and `fromActor` was attributed to "user"
instead of "codex". The third session out of four was the only one
that came out clean — and only because it manually probed CLI flags
and ended up passing `--task` and `--from` explicitly.

- **`runHandoffTask` now resolves `taskId` via the session-aware
  fallback chain.** `--task` arg → `getCurrentSessionTaskId(cwd)` →
  `project.activeTaskIds[0]`. The middle hop is the fix.
- **`runHandoffTask` now resolves `fromActor` from the session
  pointer's `startedBy` when `--from` is omitted.** Falls back to
  `ACTOR_USER` only when no session is resolvable in the cwd.
- **`runCheckpointTask` gets the same `taskId` chain** for symmetry —
  same Gap A pattern, same fix.
- **New helper `getCurrentSessionActor(cwd)`** in `session-service.ts`
  pairs with the existing `getCurrentSessionTaskId`.

### Tests

- `tests/integration/services-and-cli.test.ts`: two new regressions —
  one starts a session that claims a non-first task and asserts the
  CLI handoff lands on the claimed task with `fromActor: 'codex'`;
  the other does the same for checkpoint via `latestCheckpointId`
  inspection.
- Test infra: `mkdtemp` results are now `realpath`-ed before use, so
  the macOS `/var/folders` → `/private/var/folders` symlink mismatch
  between the test process and spawned CLI subprocesses no longer
  breaks bindings lookups.

## [1.0.0-rc.6] — 2026-05-05

### Picker-aware session lifecycle (β step 1+2, dogfood-verified)

The rc.5 β redesign moved lifecycle off the per-turn `Stop` hook onto
`SessionEnd` + an auto-reap inside `startSession`. Dogfood feedback:
users who routinely `claude --resume` a long-lived role session would
see their pointer wiped the next time an unrelated session started in
the same cwd, because auto-reap couldn't tell "abandoned" from
"intentionally idle." rc.6 separates the two concerns.

### Changed (no breaking surface, but the contract has shifted)

- **Picker view filters stale sessions without mutating their status.**
  `readActiveSessions` now hides sessions whose `lastSeenAt` is older
  than `MEMORIZE_STALE_SESSION_MS` (default 30 min) from the
  startup-context picker. Their on-disk status stays `active` and the
  cwd pointer stays where it is; only the picker view changes. A
  long-idle role session is invisible to other agents but instantly
  reattachable on resume.
- **`startSession` no longer auto-reaps prior pointers in the same
  cwd.** Status mutation (`active` → `abandoned`) is now reachable
  only through the explicit `memorize session reap [--force]` command.
  Three sequential `startSession` calls with `MEMORIZE_STALE_SESSION_MS=0`
  leave all three pointers on disk — locked into the test suite as a
  contract.
- **Resume detection on SessionStart.** When the SessionStart hook
  payload carries an `agent session_id` (Claude UUID, Codex session
  UUID) that already matches a cwd pointer's stored `agentSessionId`,
  the handler reattaches to that memorize session instead of minting
  a new one. New event type `session.resumed` records the reattach
  on the projection without a status transition.
- **`agentPid` captured on SessionStart.** The hook walks up its
  parent process tree (`ps -o pid,ppid,comm`) looking for a `claude`
  or `codex` ancestor, then stamps the resulting pid on the cwd
  pointer. Resume rewrites it with the new agent process pid.

### Verified end-to-end

- **`claude --resume <uuid>`** — Claude preserves its session UUID
  across resume; resume detection reattaches to the same memorize
  session. Locked in as a regression in
  `tests/integration/claude-hook-lifecycle.test.ts` (one
  `session.started`, ≥1 `session.resumed`, single pointer survives).
- **`codex resume`** — verified by dogfood in the duo-pane fixture.
  Codex preserves its agent session UUID across resume too, so the
  same code path works for both agents. Caveat: codex fires
  SessionStart **lazily** — not on the `codex resume` command itself,
  but on the first user turn after the resumed session starts. By
  the time anything observable happens, our hook has already run; the
  laziness is invisible at the memorize layer.
- **Picker stale-hide** — locked in as
  `tests/integration/picker-deconflict.test.ts`: a back-dated session
  disappears from `loadStartContext.otherActiveTasks` while its
  on-disk record still reads `status: "active"`.

### Tests

- 180 → 184 (added: resume reuse, picker stale-hide, resumeSession
  unit coverage, process-tree liveness/walk).

## [1.0.0-rc.5] — 2026-05-03

### Fixed (β verification follow-ups)

- **SessionEnd hook env propagation** — verified empirically that
  Claude does NOT pass `MEMORIZE_SESSION_ID` into the SessionEnd hook
  subprocess (despite SessionStart's exported env reaching every other
  Bash/tool subprocess). Without env, `endSession` couldn't find its
  cwd pointer and silently returned, so `session.completed` never
  fired and pointers leaked on every real `/exit` or `Ctrl+C`. Fix:
  the SessionStart hook now stamps the agent's own session id (Claude
  UUID, etc.) on the cwd pointer as `agentSessionId`, and SessionEnd
  resolves the calling memorize session via `payload.session_id` →
  `agentSessionId` lookup. Env/tty fall back as a safety net.
- **Bare `memorize` hook command when on PATH** — Claude doesn't wait
  for SessionEnd to finish before exiting; the npx wrapper barely
  loaded node before getting reaped. Install now uses bare `memorize
  hook ...` when memorize is on PATH (launches in milliseconds) and
  falls back to `npx ...` only when it isn't. Override via
  `MEMORIZE_HOOK_COMMAND_FORM=npx|bare`.

### Session lifecycle redesign (β track). The rc.0..rc.4 line treated
Claude's `Stop` hook as session-end; in fact `Stop` fires per assistant
turn, which produced one bogus auto-handoff per turn and (in rc.3+)
caused per-turn `session.completed` event attempts. Verified by data:
the duo-pane dogfood log shows 4 handoffs in 49 seconds across a single
session. Codex has the same per-turn `Stop` semantics and no
session-end hook of any kind.

This release moves session lifecycle off per-turn hooks entirely.

### Changed (breaking for anyone who depended on per-turn auto-handoffs)

- **`Stop` hook is now a no-op.** Both `memorize hook claude Stop` and
  `memorize hook codex Stop` return `{}`. They no longer create
  handoffs and no longer touch the session pointer. Pre-β installs
  that still register Stop continue to work — the no-op response
  satisfies the schema. `memorize install claude` and `memorize
  install codex` strip memorize's Stop registration on re-run while
  preserving any user-added Stop entries for other tools.
- **Handoffs are agent-initiated.** Agents must call `memorize
  handoff create ...` explicitly when they actually want to summarize
  work and pass control. Auto-creation per turn is gone.
- **Claude `SessionEnd` hook is registered on install.** It fires on
  every termination path Claude exposes (clean `/exit`, `Ctrl+C`,
  terminal close — see `reason` field) and writes a clean
  `session.completed` plus unlinks the cwd pointer.
- **Codex lifecycle owned entirely by `reapStaleSessions`.** Codex
  has no `SessionEnd` / `Shutdown` hook (verified against
  developers.openai.com/codex/hooks 2026-05). The next codex
  `SessionStart` in the same cwd reaps prior abandoned pointers; the
  new `memorize session reap` command lets users force a sweep.

### Added

- **`session.abandoned` event + Session status.** Distinct from
  `session.completed`: a session that ended without a clean shutdown
  (Ctrl+C, crash, codex exit, heartbeat timeout). The picker treats
  abandoned the same as completed (not active) so the underlying
  task is fair game for the next agent.
- **`reapStaleSessions(cwd, { force? })`.** Sweeps cwd pointers past
  the heartbeat staleness threshold (`MEMORIZE_STALE_SESSION_MS`,
  default 30 min). Triggered automatically by `startSession` and
  exposed via `memorize session reap`.
- **`memorize session reap [--force]` CLI command.**

### Fixed (carried from the partial rc.4 work)

- **Gap B — `CLAUDE_ENV_FILE` propagation.** memorize was writing
  `KEY="value"` lines to a `.sh` script Claude sources; without
  `export` the assignments stayed shell-local. Now writes
  `export KEY="value"`. Verifiable via `env | grep MEMORIZE`.
- **Gap A — checkpoint task attribution.** `PostCompact` resolved
  the active task via `project.activeTaskIds[0]`, picking an
  arbitrary other agent's work whenever the calling session was on
  something else. Now reads the task this session claimed at
  `SessionStart` (via `getCurrentSessionTaskId`).

### Documented

- **Gap C — Codex sandbox + memorize home.** Codex's default
  workspace-write sandbox blocks writes to `~/.memorize/`. Workaround:
  allowlist `~/.memorize` or set `MEMORIZE_ROOT` inside the sandbox.
- **Lifecycle ownership.** `AGENT_GUIDE.md` now documents the new
  `SessionStart` → heartbeat → `SessionEnd` / reap flow and the
  agent-initiated handoff contract.

### Skipped

The `1.0.0-rc.4` cut never shipped — it was rolled forward into rc.5
when the Stop=session-end design flaw was discovered during rc.4
verification. See `tests/integration/task-aware-hooks.test.ts` and
`AGENT_GUIDE.md` for the post-β contract.

## [1.0.0-rc.3] — 2026-05-03

Two bugs surfaced by the rc.2 dogfood against the duo-pane test
project. Both would have shipped to 1.0 had we not actually run four
parallel agents.

### Fixed

- **Auto-picker now deconflicts against active sessions.** The
  `loadStartContext` task picker used to return `candidateTasks[0]` as
  a final fallback, with the result that four sessions started
  90 seconds apart were all assigned the same first task. Now the
  picker filters out tasks already claimed by other active sessions
  (excluding `selfSessionId`) before falling back to a deterministic
  pick. The `otherActiveTasks` list is no longer purely informational —
  the picker itself uses the same data.
- **`bumpHeartbeat` and `endSession` no longer guess.** The rc.2
  most-recent-active fallback was attributing telemetry to the wrong
  session whenever neither env propagation nor tty matching worked
  (the common case for Claude's tool subprocesses and for Codex
  entirely). The dogfood found Claude's Stop hook killing a codex
  session via this path. Telemetry callers now silently no-op when
  they cannot reliably identify the calling session — better a missed
  heartbeat than a wrong attribution.
- **`endSession` accepts an explicit `sessionId` option.** Stop hook
  payloads carry the agent's `session_id`; the hook handler now
  forwards it to `endSession` so attribution is correct even when env
  and tty disambiguation both fail.

### Notes

- `getCurrentSessionId` keeps the most-recent-active fallback (opt-in
  via `findCwdSession` flag) because it is the ambient-CLI entry point
  that must always return a sessionId. Telemetry/lifecycle callers do
  not opt in.

## [1.0.0-rc.2] — 2026-05-03

Architectural fix surfaced while planning Sprint 3-4 dogfooding. The
"one cwd = one session" assumption baked into the rc.0/rc.1 session
pointer broke the common case of running two Claude (or Claude + Codex)
sessions in the same project directory — heartbeats from the second
session would clobber the first's pointer and the assignment-model
freshness label would lie.

### Changed

- **Session pointer layout.** `<cwd>/.memorize/current-session.json`
  (single pointer) → `<cwd>/.memorize/sessions/<sessionId>.json`
  (one file per active session). Each pointer stores the starting tty
  rdev so subprocesses can attribute themselves back to the right
  session.
- **Session resolution priority** for `bumpHeartbeat`, `endSession`,
  `getCurrentSessionId`: `MEMORIZE_SESSION_ID` env (Claude path) → tty
  match (Codex path) → most-recently-started active pointer (ambient
  CLI fallback).

### Migration

- A legacy `current-session.json` is migrated automatically the first
  time any session-service entry point runs in that cwd; the original
  file is then removed. No user action required.

### Why this matters for 1.0

The Sprint 2 lock-free assignment model only works if heartbeats reach
the right session. Without this fix, two parallel Claude sessions in
the same project would each see the other as `stale (likely abandoned)`
within minutes and start picking up each other's tasks — exactly the
failure mode dogfooding is meant to validate against.

## [1.0.0-rc.1] — 2026-05-03

Pre-dogfooding cleanup. Surfaced while preparing the duo-pane test
project: legacy memorize bootstrap blocks were being left in `AGENTS.md`
across `install codex` runs.

### Fixed

- `install codex` now also strips legacy `<!-- memorize:bootstrap -->`
  blocks from `AGENTS.md` (in addition to `AGENTS.override.md`). The
  `AGENTS.md` file is user-owned, so the strip never deletes it even if
  the file ends up empty — that decision belongs to the user.

## [1.0.0-rc.0] — 2026-05-03

First release candidate. The 1.0 promise: the on-disk layout described in
the "Storage" section of the inventory and the CLI command surface listed
under `## Day-to-day commands` in the README will not break compatibility
within the 1.x line.

### Added

- **Lock-free informational assignment model.** `Session` entity is now
  fully wired: `session.started` / `session.heartbeat` / `session.completed`
  events are emitted, projector reduces them into a sessions map, and a
  CLI middleware pumps a heartbeat after every non-session-managing command.
- **Other active tasks in the startup payload.** `task resume` (and the
  hook-rendered SessionStart context) now lists tasks held by other live
  sessions with a freshness label (`active 5m ago`, `stale ~2h ago`,
  `stale (likely abandoned)`) so a parallel agent can pick a different
  task and avoid duplicate work.
- **PostCompact summary surfacing.** When a Claude session is resumed
  after a context compact, the latest `Checkpoint.summary` for the
  picked-up task is rendered into the new session's startup payload so
  continuity is preserved.
- **Renderer character budget.** Startup payloads have a soft cap
  (default 8000 chars, ~2000 tokens) with strict-priority block ordering
  (project > task > handoff > checkpoint > conflicts > other-tasks >
  topics). Overflow drops the lowest-priority blocks and emits a budget
  notice listing what was omitted.
- **Sync golden test.** `tests/golden/sync-roundtrip-golden.test.ts`
  pins which event types cross the wire (session events DO, sync state
  does NOT) — any future filter change is a breaking change and must
  bump major.
- **Quickstart demo.** `examples/quickstart.sh` is a self-contained
  30-second sequence (project setup → task create → task resume →
  checkpoint) intended for asciinema/GIF recording. An integration test
  locks the script's milestones so the public asset cannot rot silently.

### Changed

- `MEMORY.md`-style task assignment is no longer enforced — the design is
  intentionally informational. Memorize records who is on what; agents
  decide whether to defer.
- Renderer blocks are now built with explicit priorities and an optional
  `{ budget }` argument so tests can drive drop scenarios without padding
  payloads to many kilobytes.

### Removed

- `do "<sentence>"` experimental NL intent router. Agents call task /
  handoff commands directly; the indirection was not earning its keep.
- `launch claude|codex` legacy wrapper. `install <agent>` is the standard
  entry point now.
- `workstream.updated`, `checklist.item.upserted` events and the
  `ChecklistItem` entity (declared but never reduced).

### Experimental (NOT covered by the 1.0 compatibility promise)

- `memorize project sync [--push|--pull|--bind|--remote-path]`. The file
  transport is functional and roundtrip-tested but real cross-machine
  dogfooding is post-1.0. Treat its CLI flags and on-disk wire format
  as subject to breaking change in a 1.x minor release.
- `sync.state.updated` event type (local bookkeeping; intentionally
  filtered from sync push payloads).

## [0.2.0-alpha.0] — 2026-04-21

Last alpha cut before the 1.0 stabilization sprints.

- Codex hook integration (`install codex` writes to global
  `~/.codex/hooks.json`; `doctor` verifies install).
- Doctor `fix` text for missing `project setup` corrected.
- Codex install now strips legacy blocks instead of writing new ones,
  preserves hook order (memorize first), and is idempotent.
- Codex hooks are now the documented integration contract.
