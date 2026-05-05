# Changelog

All notable changes to `@shakystar/memorize` are recorded here.

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
loosely. The project adheres to [Semantic Versioning](https://semver.org/);
major-version bumps are reserved for breaking changes to the on-disk event
log layout or the public CLI surface.

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
