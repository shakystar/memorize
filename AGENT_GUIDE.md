# AGENT_GUIDE.md

Reference for AI coding assistants (Claude Code, Codex, and similar
agents) consuming `@shakystar/memorize`. Humans do not need to read
this file end-to-end — the README is the human entry point.

This file assumes you already read the **For AI assistants** section of
the README and ran the setup steps. It exists so you can look up the
full behaviour, flags, idempotency guarantees, and failure modes of
every command without guessing.

Ship location: the repo root
(`https://github.com/shakystar/memorize/blob/main/AGENT_GUIDE.md`) and
inside the npm tarball (listed in `package.json#files`).

---

## Ground rule: memorize is the single source of truth

**Do not duplicate memorize state in your own memory system.** If you
maintain your own long-term memory (Claude Code `MEMORY.md`, Cursor
saved context, etc.):

- ✅ OK: a one-line note "memorize is installed in this project;
  always query it for state."
- ❌ Not OK: recording the project id, current tasks, handoff text,
  rule contents, decisions, or any other data memorize tracks.

Reason: your memory cannot follow memorize's state when the user runs
`project setup` again, wipes `~/.memorize/`, or the project id is
otherwise regenerated. A stale pointer in your memory will diverge
silently from reality and produce wrong answers. Always ask memorize
at session start:

```sh
npx @shakystar/memorize task resume   # full startup payload as JSON
npx @shakystar/memorize project show  # bound project entity
npx @shakystar/memorize doctor --json # health + install state
```

Treat any information in your own memory that overlaps with these
outputs as a cache that must be re-validated — not as authoritative.

## Mental model

1. **Event log** is the source of truth. Every task, handoff,
   checkpoint, rule, decision, and conflict is an append-only event
   under `.memorize/<project-id>/events/YYYY-MM-DD.ndjson`.
2. **Projection** is a derived cache rebuilt from the event log.
   Safe to delete; `memorize projection rebuild` regenerates it.
3. **Startup payload** is a small bundle built from the projection
   and rendered per-agent (`claude` vs `codex` formats differ).
4. **Install hooks** wire your agent runtime:
   - Claude Code: `.claude/settings.local.json` (per-project) — registers
     `SessionStart`, `PreCompact`, `PostCompact`, `SessionEnd`.
   - Codex: `~/.codex/hooks.json` (global per-user; the handler no-ops
     when cwd is not a memorize-bound project) — registers `SessionStart`
     only. Codex has no SessionEnd / Shutdown hook.

   In both cases the SessionStart hook calls `memorize hook <agent>
   SessionStart` and the output is injected as
   `hookSpecificOutput.additionalContext`.

5. **Session lifecycle** is owned by memorize, not by per-turn hooks.
   - `SessionStart` mints a new session, claims a task (best-effort),
     and reaps any prior abandoned pointers in the same cwd.
   - Heartbeat events fire from every memorize CLI call — they keep
     the session's `lastSeenAt` fresh.
   - Claude `SessionEnd` writes `session.completed` and unlinks the
     cwd pointer when the agent exits cleanly.
   - For Ctrl+C, crashes, and Codex (which has no end-hook), the next
     `SessionStart` in the same cwd reaps stale pointers (older than
     30 min by default; tunable via `MEMORIZE_STALE_SESSION_MS`) and
     emits `session.abandoned`. Run `memorize session reap` to force a
     sweep at any time.
6. **Handoffs are agent-initiated.** The `Stop` hook used to auto-write
   a handoff at every assistant turn — that conflated "turn end" with
   "session end." Now agents call `memorize handoff create ...` only
   when they actually want to hand off control or summarize their work
   for the next agent. Treat handoffs as intentional artifacts, not
   automatic ones.

You interact with memorize through the CLI; never hand-edit
`.memorize/` files.

---

## File layout (under `MEMORIZE_ROOT`)

```
<MEMORIZE_ROOT>/
├── profile/
│   └── bindings.json                # path → projectId (walk-up resolved)
└── projects/
    └── <projectId>/
        ├── project.json             # projection (rebuilt from events)
        ├── memory-index.json        # derived summary index
        ├── events/
        │   └── YYYY-MM-DD.ndjson    # append-only, integrity-checked
        ├── tasks/<taskId>.json
        ├── workstreams/<wsId>.json
        ├── handoffs/<handoffId>.json
        ├── checkpoints/<id>.json
        ├── decisions/<id>.json
        ├── rules/<id>.json
        ├── conflicts/<id>.json
        ├── topics/<topicId>.md
        └── sync/
            ├── remote.json          # sync state
            └── inbound.ndjson       # pending remote events
```

Defaults: `MEMORIZE_ROOT` env overrides the location; if unset,
memorize uses `<os.homedir()>/.memorize`. Set `MEMORIZE_ROOT`
when running tests or in CI to isolate state.

In the user's project directory, a small `.memorize/` may also appear
for per-project runtime state (current session, bootstrap files). The
`.memorize/` directory should be listed in the project's `.gitignore`;
`memorize doctor` warns if it is not.

---

## Binding resolution

`resolveProjectIdForPath(cwd)` walks upward: `cwd → parent → … → /`.
The nearest ancestor that was previously bound wins. This means:

- `memorize task list` from `~/work/myproj/src/components` resolves
  to the `~/work/myproj` binding.
- Nested bindings (a bound project directory containing another bound
  project directory) resolve to the closer one.
- If no ancestor is bound, commands that require a project fail with
  `No project bound to current directory.`

---

## Commands

Flags marked `boolean` accept `--flag` (no value). Flags marked
`single` accept `--flag value` or `--flag=value`. Flags marked
`multi` may be repeated and collected into an array.

### `memorize doctor [--json]`

Runs a sequence of checks on the current project and integration.
Human-readable by default; `--json` emits a stable shape:

```json
{
  "status": "ok | warn | error",
  "checks": [
    { "id": "...", "label": "...", "status": "ok|warn|error",
      "message": "...", "fix": "suggested command or action" }
  ],
  "issues": [
    { "id": "...", "severity": "warn|error", "fix": "..." }
  ],
  "version": "1"
}
```

Common checks: project binding, required directories, git redaction
risk (`.memorize/` in `.gitignore`), install state.

Exit code: `1` when status is not `ok`. Use `--json` for scripting.

### `memorize project setup`

Idempotent adoption command. Use this for existing projects.

- Binds cwd to a project (creates one if not already bound).
- Imports context files if present: `AGENTS.md`, `CLAUDE.md`,
  `GEMINI.md`, `.cursorrules`, and every `.md` / `.mdc` under
  `.cursor/rules/`.
- Detects conflicts between imported rules (e.g. "small commits" vs
  "squash on merge") and logs them as `conflict.detected` events.
- Safe to re-run; files that do not exist are skipped, and already
  imported content is merged rather than duplicated.

### `memorize project init [--force]`

Low-level "create a fresh project, bind this cwd to it" command.

- Refuses to run if the cwd is already bound; error message steers
  the caller toward `project setup`.
- `--force` overwrites the binding with a new project (old events
  remain on disk under their old id, but are no longer reachable via
  cwd). Use sparingly.

Most callers should not use `init` directly. `setup` is the correct
entry point.

### `memorize project show`

Reads the bound project's `project.json` projection and prints it as
JSON. Read-only; safe any time.

### `memorize project inspect`

Human-readable summary of the bound project (title, counts,
workstreams, active tasks). Not structured; use `project show` if you
need JSON.

### `memorize project sync [flags]` (experimental)

> **Experimental in 1.x.** The file transport works and is roundtrip-tested,
> but real cross-machine dogfooding is post-1.0. Flags and on-disk wire
> format may change in a 1.x minor release. Do not depend on it for
> production sharing yet.

Event sync with a remote path.

| Flag | Shape | Purpose |
|---|---|---|
| `--bind <remoteProjectId>` | single | Bind this local project to a remote project id |
| `--push` | boolean | Push queued events to the remote |
| `--pull` | boolean | Pull new events from the remote and merge |
| `--remote-path <dir>` | single | Required with `--push`/`--pull`. Points at a filesystem transport location. |

Running with no flags prints the current sync state and queue
snapshot as JSON.

### `memorize task create "<title>"`

Appends a `task.created` event. Actor defaults to `user`. Title is
required and becomes the default description/goal.

### `memorize task list [flags]`

| Flag | Shape | Purpose |
|---|---|---|
| `--status <s>` | single | `todo` / `in_progress` / `blocked` / `handoff_ready` / `done` |
| `--workstream <id>` | single | Filter by workstream |

Output: tab-separated `id\tstatus\tpriority\ttitle`, sorted by
`createdAt` ascending. `No tasks found.` when the filter is empty.

### `memorize task show <taskId>`

Prints the task JSON.

### `memorize task resume` (alias `start`)

Loads the startup context payload for the current project (task
auto-selected: in_progress → handoff_ready → first) and prints it as
JSON. This is what an agent reads on `SessionStart`.

### `memorize task checkpoint --summary "<text>" [flags]`

Records a mid-session snapshot.

| Flag | Shape | Purpose |
|---|---|---|
| `--summary <text>` | single | Required |
| `--session <id>` | single | Overrides the ambient session id |
| `--task <taskId>` | single | Explicit task binding |
| `--task-update <text>` | multi | Item added to `taskUpdates` |
| `--project-update <text>` | multi | Item added to `projectUpdates` |
| `--deferred <text>` | multi | Item added to `deferredItems` |
| `--discard <text>` | multi | Item added to `discardableItems` |

### `memorize task handoff --summary "<text>" --next "<text>" [flags]`

Records a handoff intent to the next agent. The handoff forces the
task status to `handoff_ready`.

| Flag | Shape | Purpose |
|---|---|---|
| `--summary <text>` | single | Required |
| `--next <text>` | single | Required. The next action. |
| `--from <actor>` | single | Default `user` |
| `--to <actor>` | single | Default `next-agent` |
| `--task <taskId>` | single | Overrides the auto-selected task |
| `--confidence low\|medium\|high` | single | Default `medium` |
| `--done <text>` | multi | Item added to `doneItems` |
| `--remaining <text>` | multi | Item added to `remainingItems` |
| `--warning <text>` | multi | Item added to `warnings` |
| `--question <text>` | multi | Item added to `unresolvedQuestions` |

### `memorize install claude`

Idempotent. Writes hook entries into `.claude/settings.local.json`
under the `hooks` map for these events:

- `SessionStart` → injects the startup context as `additionalContext`.
- `PreCompact` → captures checkpoint data before compaction.
- `PostCompact` → records a `compactSummary` checkpoint.
- `Stop` → creates a handoff with `fromActor=claude`.

Existing user hooks for the same events are preserved — memorize
appends its own command array entry, it does not overwrite.

### `memorize install codex`

Idempotent. Writes to `~/.codex/hooks.json` only.

- Adds memorize's `SessionStart` and `Stop` hook entries.
- Memorize entries are **prepended** before any existing third-party
  entries (OMX, etc.) so memorize context is established first.
- Legacy `{command}`-only entries (if any) are migrated to the
  current `{matcher, hooks: [{type, command}]}` shape in the same
  pass.
- On re-install, any pre-v0.2 `<!-- memorize:bootstrap v=1 ... -->`
  block in `AGENTS.override.md` is stripped; the file is removed if
  it becomes empty. Hooks are the authoritative contract now and the
  in-repo bootstrap block was pure duplication.

**Note: codex hooks are global.** `~/.codex/hooks.json` lives under
your home directory, not in the project, so every codex session on
your machine will invoke the memorize hook. In unrelated directories
that are not bound to a memorize project, the hook resolves to a
no-op (`{}`) — memorize is silent there.

**Note: codex sandbox + memorize home directory.** memorize stores
project state under `~/.memorize/` (overridable via `MEMORIZE_ROOT`).
Codex's default workspace-write sandbox blocks writes outside the
project root, so memorize CLI invocations from inside a sandboxed
codex session — including the ones the agent itself runs to record
handoffs — will fail unless `~/.memorize/` is added to the sandbox's
writable roots. The `Stop` hook handler still attributes the session
correctly because it runs outside the sandbox; the failure mode is
agent-initiated writes during the session (e.g. `memorize handoff
create` from inside a codex turn).

### `memorize hook claude <EventName>`

Internal entry point called by the hooks installed via
`install claude`. Humans and AIs typically do not invoke this
directly. See `src/services/hook-service.ts` for the stdin contract.

### `memorize conflict list`

Lists all open conflicts for the bound project as JSON.

### `memorize events validate`

Reads every event ndjson for the current project and reports corrupt
lines without throwing. Useful when `doctor` flagged integrity issues.

### `memorize projection rebuild`

Re-reduces the event log and rewrites every entity JSON. Idempotent;
safe to run at any time.

### `memorize memory-index rebuild`

Regenerates `memory-index.json` from the current projection. Usually
handled automatically after writes.

---

## Failure modes and how to recover

| Symptom | Likely cause | Fix |
|---|---|---|
| `No project bound to current directory.` | `project setup` never ran, or `~/.memorize/profile/bindings.json` was deleted | From the project root, run `memorize project setup` |
| `Directory is already bound to project proj_...` | `project init` re-run on a bound dir | Use `memorize project setup` (idempotent) or `--force` |
| Claude session shows no context | Install incomplete or `.claude/settings.local.json` edited | `memorize doctor` → check `hook.*` rows → re-run `memorize install claude` |
| `task list` empty but you created tasks elsewhere | Different cwd resolves to a different project | Run `memorize project show` to confirm the project id and cd to the right root |
| Integrity warnings | Corrupt ndjson line (disk full, crash mid-append) | `memorize events validate` then `memorize projection rebuild` |
| `.memorize/` committed to git | `.gitignore` missing entry | Add `.memorize/` to `.gitignore`; existing commits need manual cleanup |
| Hook file clobbered | User rewrote `.claude/settings.local.json` manually | Re-run `memorize install claude`; memorize preserves other hook entries |
| Codex agent sees `EACCES` writing to `~/.memorize/...` | Codex sandbox blocks writes outside project root | Add `~/.memorize` to the codex sandbox writable roots, or set `MEMORIZE_ROOT` to a path inside the sandbox |

---

## Idempotency guarantees

- `install claude` / `install codex` can be run any number of times
  without duplicating content or breaking unrelated user entries.
- `project setup` merges rather than overwrites imported context. New
  content files are picked up; removed files no longer appear in the
  rule list after the next rebuild.
- `projection rebuild` and `memory-index rebuild` can be run at any
  time. The event log is authoritative; projections are disposable.

---

## Event types (for code that reads the log)

Types used in `.memorize/<pid>/events/*.ndjson`:

- `project.created`, `project.updated`
- `workstream.created`
- `task.created`, `task.updated`
- `handoff.created`
- `checkpoint.created`
- `decision.proposed`, `decision.accepted`
- `rule.upserted`
- `conflict.detected`, `conflict.resolved`

Each event wraps its payload under a `payload` field and includes
`id`, `projectId`, `scopeType`, `scopeId`, `actor`, and `createdAt`.

---

## When in doubt

1. Run `memorize doctor --json` first — the `checks[]` array tells
   you what the tool itself thinks is wrong.
2. Follow the `fix` field literally where one is suggested; each fix
   is a real command or action.
3. If a command fails in a way this guide does not cover, check the
   source under `src/cli/commands/` and `src/services/` — they are
   small files (100–200 lines each) and named after the command.
