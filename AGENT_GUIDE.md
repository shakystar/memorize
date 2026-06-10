# AGENT_GUIDE.md

Reference for AI coding assistants (Claude Code, Codex, and similar
agents) consuming `@shakystar/memorize`. Humans do not need to read
this file end-to-end — the README is the human entry point.

This file assumes you already ran the setup steps in
[guides/AI_SETUP.md](./guides/AI_SETUP.md). It exists so you can look up the
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
     when cwd is not a memorize-bound project) — registers
     `SessionStart`, `PostToolUse` (capture), and `PostCompact`
     (consolidation boundary). Codex has no SessionEnd / Shutdown hook.

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
            └── remote.json          # sync state
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

Common checks: project binding, required directories, consolidation
health (observations pending consolidation plus when/where/how the
last consolidation attempt ended — warns when a backlog is stuck),
git redaction risk (`.memorize/` in `.gitignore`), install state.

Exit code: `1` when status is not `ok`. Use `--json` for scripting.

### `memorize consolidate [--session <id>] [--boundary <label>] [--report]`

Runs one memory-consolidation boundary for the project bound to cwd:
collects observations past the watermark, extracts consolidated
memories through the configured backend (see the LLM env section), and
appends them as events. This is the same command the boundary hooks
(SessionStart catch-up / PostCompact / SessionEnd) spawn as a detached
background child — running it by hand is equally valid and idempotent
(an already-consumed window is a clean no-op).

- `--session <id>` (single) — attribute the consolidated events to that
  session and its agent actor.
- `--boundary <label>` (single) — telemetry label for the recorded
  attempt (`session-start | post-compact | session-end | manual`); junk
  or missing values read as `manual` and never fail the run.
- `--report` (boolean) — do NOT consolidate; print the observed
  lifecycle-evidence distribution as JSON instead (#57): per kind the
  memory count, how many carry `obsoleteWhen`, the kind-misfit count and
  tag counts, plus the verbatim `obsoleteWhen` conditions and misfit
  reasons. A `behavior` block (#62) adds the observed side per kind:
  memories injected at least once + total injections (startup and
  mid-session live share), superseded / contradicted / deduped counts,
  and the age-at-invalidation distribution in days. Read-only; includes
  superseded/deduped rows because the evidence is about how memories
  lived, not what is currently valid.

The extractor may attach observe-only lifecycle-evidence fields to each
memory (`obsoleteWhen`, `kindMisfit` + `kindMisfitReason`,
`supersedesNote`, `tags`). They are persisted and surfaced by
`--report`, but no consumer reads them — injection, dedup, and
contradiction detection key on `kind` exactly as before, and a missing
or malformed field never fails an extraction.

### `memorize session list` / `memorize session activity [--limit N] [--json]`

#83 — the on-demand answer when the user asks **"what are my other
sessions doing?"**. Reach for THIS, not `task list`: tasks are explicit
artifacts created with `memorize task create`, so a project can have
several busy sessions and zero tasks — **sessions ≠ tasks**.

- `session list` — claiming sessions (active/paused within the staleness
  threshold): id, actor, status, lastSeenAt, claimed task when any. The
  asking session is marked `self` when resolvable.
- `session activity` — the same list plus each session's recent captured
  observations (default 10, `--limit N`). Sessions with no captured
  activity are shown as "(no captured activity yet)" rather than
  omitted — plan-mode sessions mostly read, and read-only tools are
  deliberately not captured.
- `--json` for the machine-readable form.

Live sibling sharing (mid-session injection) is push-based and stays
silent on a session's first compose; this command is the pull-based
complement for answering on demand.

### `memorize version`

Prints the version of the binary that actually ran — `npx` resolves a
project-local devDependency before the global install, so when behavior
looks stale, run this both inside and outside the project to detect a
pinned old version (#82).

### `memorize memory import --source <label> [--session <id>]`

#69 — the ingestion primitive for **agent-driven absorption** of context
that predates memorize in a project: your own harness memory (Claude
Code `MEMORY.md` and linked files), `CLAUDE.local.md` /
`AGENTS.override.md` content, and user-named doc folders (ADRs, plans,
postmortems). YOU do the reading and distillation — you have the read
access, you know where your own memory lives, and you can honor the
per-self/shared split; memorize only ingests the result and never reads
outside the project tree.

- stdin: a JSON array of extractor-shaped items —
  `[{"kind":"decision"|"rationale"|"progress","text":string,`
  `"salience":1-10,"obsoleteWhen"?:string,"tags"?:string[],...}]`
  (same shape and sanitizers as boundary consolidation, so the #57
  lifecycle-evidence fields ride along and malformed evidence degrades
  to "absent" rather than failing the item).
- `--source <label>` (single, required) — provenance, e.g.
  `claude-memory`, `docs/adr`; stored on each memory as `importSource`.
- `--session <id>` (single) — attribute events to that session's actor.
- Distillation rules: import **project state only** (decisions,
  constraints, progress, rationale). User preferences and your own
  work-style lessons are per-self memory — they STAY in your harness
  memory. One self-contained sentence per item; salience = how much a
  future session would regret not knowing it.
- Idempotent: items whose kind + normalized text already exist as a
  valid memory are skipped; the result JSON reports
  `{imported, skippedDuplicates}` — relay both counts to the user.
- Caps: at most 100 items per invocation. A batch with zero valid items
  is an error and writes nothing.
- Imported memories are first-class: searchable, embedded (when
  configured), contradiction-checked against existing decisions, and
  ranked for injection exactly like consolidated ones.

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

### `memorize setup`

Global onboarding for a human-run install (the `curl|sh` / `irm|iex`
one-liner calls it). Detects installed agents and wires the global parts:

- Detection: an agent counts as present if its config dir (`~/.claude`,
  `~/.codex`) exists or its launcher is on PATH.
- Codex: if present, writes the global hook to `~/.codex/hooks.json`
  (same as `install codex`). Idempotent.
- Claude: detection only — Claude hooks are per-project, so `setup`
  prints the `memorize install claude` instruction rather than wiring.
- No agent detected: prints guidance and exits 0.

`setup` never touches the current working directory and never binds a
project; that is `project setup`'s job. Test-only env override:
`MEMORIZE_DETECT_PATH` replaces the PATH scanned for agent launchers.

### `memorize install claude`

Idempotent. Writes hook entries into `.claude/settings.local.json`
under the `hooks` map for these events:

- `SessionStart` → injects the startup context as `additionalContext`.
- `PreCompact` → captures checkpoint data before compaction.
- `PostCompact` → records a `compactSummary` checkpoint.
- `Stop` → creates a handoff with `fromActor=claude`.

Existing user hooks for the same events are preserved — memorize
appends its own command array entry, it does not overwrite.

Also plants the **ground-rule block** (#68) in the project's
`CLAUDE.md` inside `<!-- memorize:ground-rule v=1 -->` markers: the
single-source-of-truth contract (do not duplicate project state into
your own memory; query memorize instead; per-self content stays
yours). Creates the file when absent; re-install replaces the block in
place; `uninstall claude` strips exactly the block and never deletes
the file. The same one-line rule also rides every startup injection as
a fallback for sessions that never read the file.

### `memorize uninstall claude` / `memorize uninstall codex`

Reverses `install`. Strips memorize's hook entries (and any historical
integration blocks) from `.claude/settings.local.json` /
`~/.codex/hooks.json`, preserving your other hooks and config. Idempotent
— safe when nothing is installed. With no target (`memorize uninstall`) it
does both. Captured memory (events/projection under `MEMORIZE_ROOT`) is
NOT removed — uninstall undoes the editor integration, not the data.

### Optional: LLM extraction & semantic search (env)

All optional. With nothing configured, memory consolidation auto-detects
your agent CLI (`claude`, then `codex`) on PATH and extracts through its
existing login — no API key needed; with no CLI either, it falls back to
rule-based consolidation. Semantic search stays OFF unless configured
(FTS5 lexical search only). Point these at any OpenAI-compatible endpoint
(a cloud provider or a local Ollama) to enable richer features:

- `MEMORIZE_LLM_BACKEND` — `claude-cli` | `codex-cli` | `off`. Forces the
  host-CLI extractor (`claude -p` / `codex exec`, the user's existing
  subscription auth) or disables LLM extraction entirely (`off` =
  rule-based). Unset: an API key below wins, else CLI auto-detect.
- `MEMORIZE_LLM_ENDPOINT` / `MEMORIZE_LLM_API_KEY` / `MEMORIZE_LLM_MODEL`
  — LLM memory consolidation at boundaries, plus the semantic-contradiction
  judge. `MEMORIZE_LLM_API_KEY` must be set to enable it (use any dummy
  value, e.g. `ollama`, for a keyless local server).
- `MEMORIZE_LLM_TIMEOUT_MS` — LLM extraction timeout in milliseconds,
  for both the HTTP and host-CLI backends. Defaults are backend-specific:
  `20000` (HTTP) / `90000` (host-CLI — `claude -p` cold start plus a real
  extraction takes tens of seconds). Raise it for local CPU models, which
  can need minutes per extraction.
- `MEMORIZE_CONSOLIDATE_INLINE` — set to `1` to run boundary consolidation
  synchronously inside the hook process instead of the default detached
  background child (slower boundaries, deterministic ordering).
- `MEMORIZE_EMBEDDINGS_ENDPOINT` / `MEMORIZE_EMBEDDINGS_API_KEY` /
  `MEMORIZE_EMBEDDINGS_MODEL` — embedding-based semantic search (hybrid
  with FTS5, used in both explicit `search` and startup injection) and the
  same-topic candidate step of contradiction detection. Enabled when the
  endpoint **or** key is set (a keyless local Ollama works with just the
  endpoint).
- `MEMORIZE_CONTRADICTION_MIN_SIMILARITY` — cosine pre-filter for
  contradiction candidates (default `0.5`; tune per embedding model).

Contradiction detection needs **both** an embedder and an LLM; with either
unset it is a silent no-op. Local Ollama example:
`MEMORIZE_EMBEDDINGS_ENDPOINT=http://localhost:11434/v1`,
`MEMORIZE_EMBEDDINGS_MODEL=nomic-embed-text`,
`MEMORIZE_LLM_ENDPOINT=http://localhost:11434/v1`,
`MEMORIZE_LLM_MODEL=llama3.2:3b`, `MEMORIZE_LLM_API_KEY=ollama`.

### `memorize install codex`

Idempotent. Writes to `~/.codex/hooks.json`, and plants the
**ground-rule block** (#68) in the project's `AGENTS.md` (same managed
markers and uninstall reversal as the Claude variant above).

- Adds memorize's `SessionStart`, `PostToolUse`, and `PostCompact` hook
  entries (legacy `Stop` entries from older versions are stripped on
  re-install — Stop fires per-turn, not per-session, so the old
  auto-handoff path was removed).
- Memorize entries are **prepended** before any existing third-party
  entries (OMX, etc.) so memorize context is established first.
- Legacy `{command}`-only entries (if any) are migrated to the
  current `{matcher, hooks: [{type, command}]}` shape in the same
  pass.
- On re-install, any pre-v0.2 `<!-- memorize:bootstrap v=1 ... -->`
  block in `AGENTS.override.md` is stripped; the file is removed if
  it becomes empty. Hooks are the authoritative contract now and the
  in-repo bootstrap block was pure duplication.

**ACTION REQUIRED: approve the hooks once.** Codex silently skips
externally-written hooks — no error, no log — until you approve them
once in an interactive codex session (verified against codex
v0.137.0). Until then the entire codex integration (session
recording, capture, consolidation) is inert even though `install
codex` succeeded. Start codex interactively in any project once and
accept the hook approval prompt. `memorize doctor` infers the gap
(#37): when memorize hooks are registered but the bound project has
sessions from other agents and none from codex, it raises a `warn`.
A supported non-interactive trust grant is tracked upstream in
openai/codex#21615; once it lands, `install codex` will request
trust itself and this step disappears.

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
