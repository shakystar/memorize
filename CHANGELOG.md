# Changelog

All notable changes to `@shakystar/memorize` are recorded here.

This file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
loosely. The project adheres to [Semantic Versioning](https://semver.org/);
major-version bumps are reserved for breaking changes to the on-disk event
log layout or the public CLI surface.

## [1.0.0-rc.4] — 2026-05-03

Four gaps surfaced by the rc.3 dogfood. Gap B is the most load-bearing
(without it, every Claude tool subprocess saw `MEMORIZE_SESSION_ID` as
unset, silently degrading every other session-aware code path); Gap D
was discovered while verifying the Gap B fix.

### Fixed

- **Gap B — `CLAUDE_ENV_FILE` propagation.** Claude's
  `CLAUDE_ENV_FILE` is a shell script Claude `source`s, not a dotenv
  file. memorize was writing `KEY="value"` lines without `export`, so
  the assignments stayed shell-local and never reached the `claude`
  process or its tool subprocesses. Now writes `export KEY="value"`,
  which is what the file extension (`.sh`) implied all along.
  Verifiable in any Claude session via `env | grep MEMORIZE`.
- **Gap A — hook task attribution.** `PostCompact` and `Stop`
  resolved the active task via `project.activeTaskIds[0]`, which
  picks an arbitrary other agent's work whenever the calling session
  did not happen to claim the first task. Hook handlers now read the
  taskId the calling session itself claimed at `SessionStart` (via
  the new `getCurrentSessionTaskId`) and only fall back to the
  project-level guess when the session never claimed anything.
- **Gap D — Stop hook silently leaking sessions.** The rc.3 fix
  forwarded the agent's payload `session_id` to `endSession` as if
  it were a memorize session id. Claude/Codex payloads speak their
  own ID space (Claude UUIDs etc.), so the pointer lookup always
  missed and `endSession` returned early — `session.completed` was
  never written, pointer files leaked, and the projection
  accumulated dead "active" sessions that blocked the picker.
  Discovered in production: 13 stale active sessions claiming tasks
  in the duo-pane dogfood project. Hook handlers now ignore
  `payload.sessionId` and resolve the calling session via env/tty
  (now reliable post Gap-B). The `endSession({ sessionId })` API
  itself is preserved for memorize-aware callers (scripts, tests).

### Documented

- **Gap C — Codex sandbox + memorize home.** Codex's default
  workspace-write sandbox blocks writes to `~/.memorize/`, so
  agent-initiated memorize CLI calls inside a sandboxed turn fail
  with `EACCES`. `AGENT_GUIDE.md` now documents the workaround
  (allowlist `~/.memorize` or set `MEMORIZE_ROOT` inside the
  sandbox).

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
