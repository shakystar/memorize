# AGENT_GUIDE.md

Reference for AI coding assistants (Claude Code, Codex, and similar
agents) consuming `@shakystar/memorize`. Humans do not need to read
this file end-to-end; the README is the human entry point.

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

- OK: a one-line note "memorize is installed in this project;
  always query it for state."
- Not OK: recording the project id, current tasks, handoff text,
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
outputs as a cache that must be re-validated, not as authoritative.

## Mental model

1. **Event log** is the source of truth. Every task, handoff,
   checkpoint, rule, decision, observation, memory, and retraction is
   an append-only event in the account-scoped SQLite store.
2. **Projection** is derived state rebuilt from the event log. Safe
   rebuild commands are `memorize projection rebuild` and
   `memorize memory-index rebuild`.
3. **Startup payload** is a local bundle built from projections. It can
   include three separate channels: project memory, account-personal
   memory, and workspace-shared memory.
4. **Scope is decisive.** Project state belongs in project memory. User
   preferences and working-style facts belong in personal memory.
   Workspace membership, role, invite state, and `wsp_` identity are
   Hub control-plane facts, not domain events.
5. **Install hooks** wire your agent runtime:
   - Claude Code: `.claude/settings.local.json` (per-project) registers
     `SessionStart`, `PostToolUse` (capture), `PostCompact`, `SessionEnd`.
   - Codex: `~/.codex/hooks.json` (global per-user; the handler no-ops
     when cwd is not a memorize-bound project) registers
     `SessionStart`, `PostToolUse` (capture), and `PostCompact`
     (consolidation boundary). Codex has no SessionEnd / Shutdown hook.

   In both cases the SessionStart hook calls `memorize hook <agent>
   SessionStart` and the output is injected as
   `hookSpecificOutput.additionalContext`.

6. **Session lifecycle** is owned by memorize, not by per-turn hooks.
   - `SessionStart` mints a new session, claims a task (best-effort),
     and reaps any prior abandoned pointers in the same cwd.
   - Heartbeat events fire from every memorize CLI call; they keep
     the session's `lastSeenAt` fresh.
   - Claude `SessionEnd` writes `session.completed` and unlinks the
     cwd pointer when the agent exits cleanly.
   - For Ctrl+C, crashes, and Codex (which has no end-hook), the next
     `SessionStart` in the same cwd reaps stale pointers (older than
     30 min by default; tunable via `MEMORIZE_STALE_SESSION_MS`) and
     emits `session.abandoned`. Run `memorize session reap` to force a
     sweep at any time.
7. **Handoffs are agent-initiated.** The `Stop` hook used to auto-write
   a handoff at every assistant turn, which conflated "turn end" with
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
│   └── bindings.json                # path → projectId hints
├── credentials                      # host-scoped Hub credentials
└── accounts/
    └── <accountId>/
        ├── projects/
        │   └── <projectId>/
        │       ├── memorize.db      # events + projections + FTS + embeddings + meta
        │       ├── sync/
        │       │   └── remote.json  # Hub binding, watermarks, workspace role cache
        │       └── topics/
        │           └── <topicId>.md # imported rules as readable topics
        └── personal/
            ├── memorize.db          # account personal memory store
            ├── sync/
            │   └── remote.json      # psm_ binding when personal sync is enabled
            └── topics/
```

Defaults: `MEMORIZE_ROOT` env overrides the location; if unset,
memorize uses `<os.homedir()>/.memorize`. Set `MEMORIZE_ROOT`
when running tests or in CI to isolate state.

In the user's project directory, a small `.memorize/` may also appear
for per-project runtime state (current session, bootstrap files). The
`.memorize/` directory should be listed in the project's `.gitignore`;
`memorize doctor` warns if it is not.

Do not hand-edit files under `MEMORIZE_ROOT`. Use the CLI. The event
log is inside `memorize.db`, not in per-day ndjson files.

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
last consolidation attempt ended; warns when a backlog is stuck),
git redaction risk (`.memorize/` in `.gitignore`), install state.

Exit code: `1` when status is not `ok`. Use `--json` for scripting.

### `memorize update`

Upgrades the global CLI to the latest published version, then refreshes
every existing integration on this machine with the new binary:

- Re-installs Codex hooks (`~/.codex/hooks.json`) when memorize entries
  are already present.
- Re-installs Claude hooks for every known project that already has them
  (never installs fresh into a project that has not opted in).
- Re-imports changed context files (`CLAUDE.md`, `AGENTS.md`,
  `GEMINI.md`, `.cursorrules`, `.cursor/rules`) for every bound project.
  Idempotent: unchanged files emit nothing; changed files upsert the
  same rule in place.

Already up to date: the npm step is skipped, but the refresh still
runs. `update` therefore doubles as a repair command when integrations
drift after a manual change.

Data is never deleted: the event store is append-only. A removed context
file leaves its previously imported rule intact.

**Internal flags (not for direct use):**

- `--post-only`: refresh-only re-exec entry point called by the
  upgraded binary after `npm install -g` completes. The parent process
  exits and the new binary owns the machine-wide refresh.
- `--check`: detached registry probe spawned by `SessionStart`. Writes
  the latest available version to `~/.memorize/update-check.json`
  without installing anything.

**Failure modes:**

- No global install found: prints guidance and exits 1.
- Registry unreachable: exits 1.
- `npm install -g` fails: exit code propagated, refresh skipped.
- Per-project refresh failure: reported at the end with exit 1; the
  loop continues past individual failures so other projects still run.

**Session-start notice:** when a newer version is cached in
`update-check.json`, one line is appended to the startup context
(`memorize vX.Y.Z available, run memorize update`). The background
check is throttled to once per 24 h, runs detached, and never blocks
session start or auto-installs anything.

### `memorize consolidate [--session <id>] [--boundary <label>] [--report]`

Runs one memory-consolidation boundary for the project bound to cwd:
collects observations past the watermark and the conversation since the
last transcript byte-offset, extracts consolidated memories through the
configured backend (see the LLM env section), and appends them as
events. This is the same command the boundary hooks
(SessionStart catch-up / PostCompact / SessionEnd) spawn as a detached
background child; running it by hand is equally valid and idempotent
(an already-consumed window is a clean no-op).

- `--session <id>` (single): attribute the consolidated events to that
  session and its agent actor.
- `--boundary <label>` (single): telemetry label for the recorded
  attempt (`session-start | post-compact | session-end | manual`); junk
  or missing values read as `manual` and never fail the run.
- `--transcript <path>` (single): transcript to read the conversation
  from when no observation in the window carries one (a zero-observation,
  pure-conversation session). The boundary hooks pass this automatically
  from the hook payload; supply it by hand to consolidate a session that
  produced no tool observations. Absent for the bare manual command.
- `--report` (boolean): do NOT consolidate; print the observed
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
`--report`, but no consumer reads them: injection, dedup, and
contradiction detection key on `kind` exactly as before, and a missing
or malformed field never fails an extraction.

### `memorize watcher run`

Runs the session-bound watcher-sync loop (SoT-042/043) for the project
bound to cwd: every poll interval (default 30s) it does a watermark-gated
pull — writing a local inbound marker when events actually arrived — and a
watermark-gated push of self-lane events, so mid-session work propagates to
the workspace Hub without waiting for a session boundary. Internal surface:
SessionStart spawns it as a detached child whenever sync is configured;
running it by hand is only useful for debugging a stuck sync. A
pid-carrying lockfile guarantees one instance per project (a second `run`
exits immediately with `{"ran":false,"reason":"already-running"}`), and the
loop exits on its own once no session in the cwd has shown activity within
the heartbeat staleness threshold (`MEMORIZE_STALE_SESSION_MS`, default
30 min) — no OS service, no boot autostart. Tuning:
`MEMORIZE_WATCHER_POLL_MS` (default 30000), `MEMORIZE_WATCHER_DISABLED=1`
(never spawn; sync falls back to boundary-only cadence).

### `memorize session list` / `memorize session activity [--limit N] [--json]`

#83: the on-demand answer when the user asks **"what are my other
sessions doing?"**. Reach for THIS, not `task list`: tasks are explicit
artifacts created with `memorize task create`, so a project can have
several busy sessions and zero tasks (**sessions ≠ tasks**).

- `session list`: claiming sessions (active/paused within the staleness
  threshold): id, actor, status, lastSeenAt, claimed task when any. The
  asking session is marked `self` when resolvable.
- `session activity`: the same list plus each session's recent captured
  observations (default 10, `--limit N`). Sessions with no captured
  activity are shown as "(no captured activity yet)" rather than
  omitted; plan-mode sessions mostly read, and read-only tools are
  deliberately not captured.
- `--json` for the machine-readable form.

Live sibling sharing (mid-session injection) is push-based and stays
silent on a session's first compose; this command is the pull-based
complement for answering on demand.

### `memorize version`

Prints the version of the binary that actually ran. `npx` resolves a
project-local devDependency before the global install, so when behavior
looks stale, run this both inside and outside the project to detect a
pinned old version (#82).

### `memorize memory import --source <label> [--session <id>]`

#69: the ingestion primitive for **agent-driven absorption** of context
that predates memorize in a project: your own harness memory (Claude
Code `MEMORY.md` and linked files), `CLAUDE.local.md` /
`AGENTS.override.md` content, and user-named doc folders (ADRs, plans,
postmortems). YOU do the reading and distillation: you have the read
access, you know where your own memory lives, and you can honor the
per-self/shared split; memorize only ingests the result and never reads
outside the project tree.

- stdin: a JSON array of extractor-shaped items,
  `[{"kind":"decision"|"rationale"|"progress","text":string,`
  `"salience":1-10,"obsoleteWhen"?:string,"tags"?:string[],...}]`
  (same shape and sanitizers as boundary consolidation, so the #57
  lifecycle-evidence fields ride along and malformed evidence degrades
  to "absent" rather than failing the item).
- `--source <label>` (single, required): provenance, e.g.
  `claude-memory`, `docs/adr`; stored on each memory as `importSource`.
- `--session <id>` (single): attribute events to that session's actor.
- Distillation rules: import **project state only** (decisions,
  constraints, progress, rationale). User preferences and your own
  work-style lessons are per-self memory; they STAY in your harness
  memory. One self-contained sentence per item; salience = how much a
  future session would regret not knowing it.
- Idempotent: items whose kind + normalized text already exist as a
  valid memory are skipped; the result JSON reports
  `{imported, skippedDuplicates}` (relay both counts to the user).
- Caps: at most 100 items per invocation. A batch with zero valid items
  is an error and writes nothing.
- Imported memories are first-class: searchable, embedded (when
  configured), contradiction-checked against existing decisions, and
  ranked for injection exactly like consolidated ones.

### `memorize memory list [--json] [--limit <N>]`

#148: whole-store observation. Lists the project's **currently valid**
memories (those whose validity window is still open; superseded ones are
excluded, which is the correct default). Pure read of the derived
projection: it appends and mutates nothing. Scope is the cwd-bound
project.

- Default (human) form: one tab-separated line per memory,
  `id\tkind\tsalience\t<snippet>` where the snippet is the first ~80
  characters of the memory text on a single line.
- `--json` (boolean): emit the raw rows (memory + access metadata) as a
  JSON array instead of the human-readable lines.
- `--limit <N>` (single): cap the output at N rows (positive integer).
  Rows are ordered salience-desc, then newest-first, so the cap keeps the
  most important memories.

### `memorize memory show <memoryId> [--json]`

#111: prints a recalled memory's **full** text plus metadata. `search`
only emits a truncated snippet; this is how an agent (or human) reads a
memory's complete content once it has an id. Scope is the cwd-bound
project, mirroring how `search` resolves the project.

- `<memoryId>` (positional, required): the memory id, e.g. one returned
  by `memorize search`.
- `--json` (boolean): emit the raw row (memory + access metadata) as
  JSON instead of the human-readable rendering.
- Human form lists id, kind, salience, tags, provenance (consolidation
  vs `import (<source>)`, session, source observation ids) and the
  validity window (createdAt, last accessed, `obsoleteWhen`, `invalidAt`,
  superseded-by / deduped-by pointers), followed by the memory text.
- Fails with `no memory found with id <id>` when the id is unknown.

### `memorize memory retract <memoryId> [--reason <text>]`

M3 (SoT-050): **tombstone** a consolidated memory — the "forget this"
primitive. It appends a `memory.retracted` event and rebuilds the
projection so the memory stops surfacing in `memory list`, `search`, and
startup injection; nothing is deleted, so the memory stays auditable and
the retraction is reversible. Distinct from supersede (which closes a
memory's window because a **newer memory replaces it**): a retraction has
no replacement.

- `<memoryId>` (positional, required): the memory id, e.g. one returned
  by `memorize search` or `memorize memory list`.
- `--reason <text>` (optional): free-form note recorded on the tombstone.
- Emits `{"memoryId":"…","alreadyInvalid":<bool>}` — `alreadyInvalid` is
  true when the memory was already superseded/retracted (the tombstone is
  still recorded; the effective validity window is unchanged).
- **Global (cross-writer) retract — owner only (W-c, SoT-050, Hub H030).**
  Retracting a workspace-union memory that another writer authored
  requires the `owner` role: the CLI verifies your role against the Hub
  control-plane (falling back to the cached role with a warning when the
  Hub is unreachable) and stamps it on the tombstone (`writerRole`).
  Every member's projection honours a cross-lane retract only when the
  event carries `writerRole:"owner"` — the judgment rides the event
  bytes, not a projection-time roster lookup, so replicas converge
  deterministically and a later demotion never rewrites history. A
  member retracting their OWN memories needs no role. Emits an extra
  `"global":true` in the result for a cross-writer retract.
- The tombstone propagates like a consolidation boundary (best-effort
  `autoPush`) so synced peers converge on the removal instead of reviving
  it on the next union. `memory show <id>` still finds it, flagged
  `retracted`, for audit.
- Fails with `Memory <id> not found` when the id is unknown.

### `memorize memory gc [--dry-run] [--json]`

M3-b (SoT-050): **physically reclaim** the bytes of retracted memories.
`retract` only tombstones (hides) a memory; the row + events stay on
disk. `gc` is the separate, opt-in sweep that hard-deletes the events of
memories that are **already retracted AND entirely local-only**
(un-pushed) — safe because no peer has those events, exactly like
`git reset --hard` on an un-pushed commit.

- Reclaims a memory only when its `memory.consolidated` **and** every one
  of its source `observation.captured` events are un-pushed. It deletes
  those events plus the source observations no surviving memory still
  references, so nothing is left for the next consolidation boundary to
  re-derive the memory from (revival-free).
- **Shared** (already-pushed) retracted memories are left as tombstones —
  deleting a row a peer still holds would let it re-sync back. Reclaiming
  those needs a propagation/retention policy and is deferred.
- `--dry-run` reports what WOULD be reclaimed without mutating anything.
- Emits `{"reclaimedMemories":[…],"reclaimedEvents":N,"reclaimedObservations":N,"skippedShared":N,"dryRun":<bool>}`.
- No `autoPush`: deleting un-pushed events has nothing to propagate.

### `memorize memory revert --session <id> [--reason <text>] [--dry-run] [--json]`

M3-c (SoT-050): **consolidated revert** — undo a contaminated session's
memories in one shot. It batch-retracts every still-valid memory tagged
with `sessionId` (reusing the `memory.retracted` tombstone) and rebuilds,
so the projection re-derives a clean view WITHOUT them. This is the
append-only form of "rewind + re-derive from a clean event set": nothing
is deleted, the revert is reversible, and the retracted rows keep
shielding their source observations so a later boundary does not revive
them.

- `--session <id>` (required): the session whose memories to revert. Ids
  come from `memorize session activity` or a memory's `session:` field in
  `memory show`.
- **Self-lane only.** A workspace-union memory belongs to another writer;
  reverting someone else's contribution is the owner-only global retract
  (SoT-040), deferred to W3.
- `--reason <text>` (optional): note recorded on each tombstone (default
  `session <id> reverted`).
- `--dry-run` lists what WOULD be reverted without appending anything.
- Emits `{"sessionId":"…","reverted":[…],"dryRun":<bool>}`. A session with
  no still-valid memories is a no-op (`reverted: []`). The tombstones
  `autoPush` so synced peers converge on the revert.

### `memorize personal import --source <label>` (+ `personal list`, `personal show`, `personal sync`)

Personal memory is an account-scoped store for facts about the user:
preferences, durable working-style rules, and cross-project habits. It
is NOT a project and NOT a `scopeType` value.

Use these rules:

- Project decisions, progress, constraints, and handoffs → project memory.
- User preferences and working-style facts → personal memory.
- `memorize.personal` startup content stays personal. Do not copy it
  into project tasks, handoffs, or summaries.
- Personal sync is same-account only. It uses the account's
  server-minted `psm_` Hub store. It must never cross accounts and must
  never merge into a workspace `wsp_` store.

Primary path: at each consolidation boundary, the extractor classifies
memories as project vs personal. Personal items route to the personal
store and stay out of the project store.

Explicit import: `personal import --source <label>` reads the same JSON
array shape as `memory import`
(`[{"kind":"decision"|"rationale"|"progress","text":string,"salience":1-10,...}]`),
is idempotent by kind + normalized text, and reports
`{imported, skippedDuplicates}`. It needs no bound project.

Read commands:

- `personal list [--json] [--limit <N>]`
- `personal show <memoryId> [--json]`

Sync command:

- `personal sync --remote-url <hub-url>`

Startup injection: top personal memories surface in their own
`memorize.personal` channel.

### `memorize workspace create --remote-url <hub-url> [--name <name>]` (+ `memorize workspace status`, `memorize workspace invite`, `memorize workspace join`, `memorize workspace members`, `memorize workspace promote|demote|remove`)

Bind the bound project to a **workspace** — a shared, multi-account project
surface. `workspace create` mints a server-minted workspace store id (`wsp_…`)
on the Hub gateway and records it as the project's remote store, layered on top
of the local `proj_` identity (which is never rekeyed). A freshly created
workspace is a **private project** (1 member, you as `owner`); it becomes shared
only once someone is invited (a later slice).

- The `wsp_` id, your `role`, and reachability are **control-plane facts** the
  client fetches from the gateway (`POST /v1/workspaces`) and caches locally —
  they are NOT domain events (Hub two-plane boundary: the relay never authors or
  parses events). Identity binding is stored client-side only.
- Requires a host credential for the Hub (`memorize auth login --remote-url
  <hub-url>` first). Idempotent: a project already workspace-bound is not
  re-minted. A public hosted Hub is available at
  https://memorize-hub-shakystar.fly.dev (open beta, free to join); `<hub-url>`
  can point at it or at a self-hosted Hub.
- `workspace status [--json]` prints the current binding (`wsp_`, role, whether
  the store is shared) or reports that the project is not workspace-bound.
- The bind also persists the Hub URL as the project's http `syncTransport`, so a
  workspace-bound project syncs flag-less (`memorize project sync --push/--pull`)
  and is auto-sync eligible — the union data-plane is the existing events route
  keyed by the `wsp_` remote id. Doctor's single-identity check is union-aware:
  foreign members' `project.created` (provenance-labeled) never false-alarm it.
- `workspace invite [--remote-url <hub-url>] [--max-uses <N>] [--expires <ISO-8601>]`
  (owner only) mints a revocable multi-use invite and prints the join token +
  URL **once** — the Hub never re-serves them. The first mint flips the store
  from private project to shared workspace; the local cache mirrors it.
- `workspace join --remote-url <hub-url> --token <invite-token>` redeems an
  invite for the calling account and binds the bound project to the joined
  workspace as `member`. A project already bound to a workspace refuses to join
  a different one.
- `workspace members [--json]` (W-c) prints the control-plane roster — each
  member's role, verified email (the display handle that maps a union lane's
  provenance back to a person), and join date. Readable by any member.
- `workspace promote|demote <accountId-or-email>` (W-c, owner only) changes a
  member's role over the Hub PATCH endpoint. Promote is also how ownership is
  transferred; demoting the sole remaining owner is refused Hub-side (409).
  The target may be named by `acc_…` id or email (resolved via the roster).
- `workspace remove <accountId-or-email>` (W-c) removes a member — an owner
  may remove anyone; any member may remove themselves (self-leave). Removal
  revokes future access only: already-pulled bytes are not recallable, and the
  member's past events remain in the shared log as provenance-labelled history.
- The cached `role`/reachability refresh from the gateway at every sync
  boundary (session-start auto-pull and manual `project sync`) — the cache is
  never authority (SoT-022).
- Role enforcement on shared memory: any member may retract their OWN
  memories; retracting **another writer's** memory is the owner-only global
  retract (see `memory retract`).

### `memorize init [--nested]`

**The recommended one-shot onboarding command** — prefer it over running
`project setup` + `install claude`/`install codex` separately. Composes the
lower-level primitives in one idempotent step:

1. `project setup` (bind/adopt cwd + auto-relocate a moved repo + import
   `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` / `.cursorrules` / `.cursor/rules/`).
2. Detects which agent CLIs are installed (same detection as `setup`:
   `~/.claude` / `~/.codex` config dirs, then PATH).
3. Wires each **present** agent — `install claude` (per-project
   `.claude/settings.local.json` + `CLAUDE.md` ground rule + `using-memorize`
   skill) and/or `install codex` (global `~/.codex/hooks.json` + this project's
   `AGENTS.md` ground rule).
4. Prints a single summary. When Codex is wired, it appends the same
   `ACTION REQUIRED` approval + sandbox `writable_roots` notice that
   `install codex` prints.

- `--nested` (alias `--force`): when cwd sits inside an already-bound ancestor,
  create a SEPARATE nested project here instead of refusing (the case
  `project init` exists for). Without it, the ancestor refusal is preserved.
- Idempotent and safe to re-run; every sub-step is the same idempotent
  primitive documented below.
- When neither agent is detected, the project is still bound + context
  imported (exit 0); the output guides the user to install an agent and
  re-run, or wire one manually.

### `memorize project setup`

Idempotent adoption command. Lower-level primitive used by `memorize init`
(prefer `init` for first-time onboarding); use `project setup` directly only
when you specifically want adoption WITHOUT touching agent integration.

- Binds cwd to a project (creates one if not already bound).
- Imports context files if present: `AGENTS.md`, `CLAUDE.md`,
  `GEMINI.md`, `.cursorrules`, and every `.md` / `.mdc` under
  `.cursor/rules/`.
- Detects conflicts between imported rules (e.g. "small commits" vs
  "squash on merge") and logs them as `conflict.detected` events.
- Safe to re-run; files that do not exist are skipped, and already
  imported content is merged rather than duplicated.

### `memorize project relocate [<newPath>] (--project <id> | --from <oldPath>)`

#124: rebinds an **existing** project to a new absolute path after the
repo moved (machine migration, directory rename). Use this, NOT
`project setup`, in a relocated checkout: `setup` would mint a *new*
empty project and orphan the original's memory.

- `<newPath>` (positional): the project's new location; defaults to cwd.
- `--project <id>` (single): identify the source project by id.
- `--from <oldPath>` (single): identify it by its previous path instead.
- One of `--project` / `--from` is required.
- Idempotent: when the project is already bound to `<newPath>` it reports
  `already bound … nothing to do` and changes nothing.

### `memorize project init [--force]`

Low-level "create a fresh project, bind this cwd to it" command.

- Refuses to run if the cwd is already bound; error message steers
  the caller toward `project setup`.
- `--force` overwrites the binding with a new project (old events
  remain on disk under their old id, but are no longer reachable via
  cwd). Use sparingly.

Most callers should not use `project init` directly. `memorize init` is the
correct entry point for onboarding (it composes adoption + agent wiring);
`memorize init --nested` covers the intentional nested-project case this
command's `--force` was for.

### `memorize project show`

Reads the bound project's `project.json` projection and prints it as
JSON. Read-only; safe any time.

### `memorize project inspect`

Human-readable summary of the bound project (title, counts,
workstreams, active tasks). Not structured; use `project show` if you
need JSON.

### `memorize project sync [flags]` (experimental)

> **Canonical remote sync is the Hub** (SoT-031): `memorize auth login
> --remote-url <hub>`, then `memorize workspace create` — after that a plain
> `memorize project sync --push/--pull` (no flags) syncs the bound workspace
> store. The file transport (`--remote-path`) is **deprecated**: it keeps
> working but is frozen and will be removed in a later release.

Event sync over the persisted transport (or one given by flag).

| Flag | Shape | Purpose |
|---|---|---|
| `--bind <remoteProjectId>` | single | Bind this local project to a remote store id |
| `--push` | boolean | Push queued events to the remote |
| `--pull` | boolean | Pull new events from the remote and merge |
| `--remote-url <url>` | single | Hub/relay URL; persisted so later boundaries auto-sync flag-less |
| `--token <t>` | single | Bearer token for `--remote-url` (written through to the host credential store, #192) |
| `--remote-path <dir>` | single | **Deprecated (SoT-031).** Filesystem transport location |

Running with no flags prints the current sync state and queue
snapshot as JSON.

**Legacy binding auto-migration (W-b full reconcile, SoT-031).** A Hub-bound
http sync whose `remoteProjectId` is still a raw client `proj_` (the
pre-workspace first-push self-bind — the Hub rejects that path with 403
"unknown store") is migrated automatically at every sync boundary: a 1-member
workspace store is minted (`POST /v1/workspaces`), the binding is repointed at
the new `wsp_`, and the push/pull watermarks reset so the full local history
re-publishes. A `wsp_` binding that lacks its control-plane role cache (e.g.
after `--bind wsp_…` or a clone on a second device) gets the cache backfilled
from account discovery instead. Both are best-effort: on failure the sync
proceeds on the legacy path and a `WARN:` explains why. `memorize doctor`
surfaces legacy shapes under the `sync.binding` check.

### `memorize project clone <remoteProjectId> (--remote-path <path> | --remote-url <url> [--token <t>]) [--encryption-key <b64>]` (experimental)

True-replica join (#30, #38): adopts an existing **remote** project's id
in a FRESH directory so the same project keeps one identity on every
machine, the git-clone analog to `project setup`, which mints a *new*
id. The remote location is persisted, so later boundaries auto-sync with
no flags (P3-b).

| Flag | Shape | Purpose |
|---|---|---|
| `<remoteProjectId>` | positional, required | The remote project id to replicate |
| `--remote-path <path>` | single | Filesystem transport location of the source |
| `--remote-url <url>` | single | HTTP relay URL of the source (alternative to `--remote-path`) |
| `--token <t>` | single | Bearer token for `--remote-url`. Optional once `memorize auth login` has stored one for the host. When passed, it is written through to the host credential store (not the per-project state) (#192) |
| `--encryption-key <b64>` | single | E2E key (#182) for an encrypted source; must match the origin's key (verify by `kid`). Seeded before the clone-time pull so it can decrypt |

Pulls existing events on clone; if the source has not pushed yet it binds
and tells you to run `project sync --pull` once it has. Same experimental
caveats as `project sync`.

**URL positional (Hub onboarding):** `memorize clone <hub-url>` is a
top-level alias of `project clone` that accepts the copy-paste URL the Hub
renders, e.g. `memorize clone https://hub.example/clone/wsp_abc123`. The
URL's **origin** becomes `--remote-url` and its **last path segment** is
the store id (`wsp_…`/`proj_…`); intermediate segments (`/clone`, …) are
display sugar and ignored, so the Hub may change its pretty paths without
breaking the client. Both spellings accept both forms.

### `memorize remote [<hub-url>] [--token <t>]` (experimental)

Git-remote analog for a project that **already exists locally** (the
other onboarding branch — `clone` is for a fresh directory). Alias of
`memorize project remote`. Parses `<hub-url>` with the same
origin-plus-last-segment rule as `clone`, persists the transport +
`remoteProjectId` into the sync state, then runs the **first push/pull
immediately** (including the W-b binding reconcile and W-c role-cache
refresh a manual sync performs), so no manual sync step follows it —
session boundaries auto-sync from there (P3-b). With no argument it
prints the attached remote id + URL, `git remote -v` style. Requires a
host credential (`memorize login <hub-url>`) or `--token`.

### `memorize connect <hub-url> [--token <t>]` (experimental)

The **recommended one-verb onboarding** for a Hub share URL: `connect`
inspects the current directory and dispatches automatically, so you do not
have to know whether to `clone` or `remote` —

- **fresh / unbound directory** → clones a replica (the `memorize clone`
  path above);
- **directory already bound to a project** → attaches the remote to it
  (the `memorize remote` path above);
- **a subdirectory nested inside another project** → refuses with an
  actionable error instead of guessing, telling you to run `memorize clone`
  in a fresh directory to join as a separate replica, or `memorize remote`
  to attach THIS project.

Parses `<hub-url>` with the same origin-plus-last-segment rule as `clone`,
validating it **before** touching the binding store. `clone` and `remote`
stay as explicit aliases when you want to force one branch. Requires a host
credential (`memorize login <hub-url>`) or `--token`.

### `memorize project encryption (enable [--key <b64>] [--force] | show | disable)` (experimental)

Provisions the per-project **E2E payload key** (#182) on the origin
machine. With a key set, each event's `payload` is encrypted with
AES-256-GCM at the sync boundary, so an untrusted relay (`memorize_hub`)
stores ciphertext and never sees memory content — only routing metadata
(event ids, types, scope, actor, sizes, timing) stays visible. The key is
**local-only**: it is never synced (the push filter drops
`sync.state.updated`), so distribution to replicas is **out-of-band** —
`enable`/`show` print the key for exactly that. This is confidentiality
and is orthogonal to the Hub bearer PAT (authorization).

| Action | Purpose |
|---|---|
| `enable [--key <b64>]` | Turn on encryption; generate a fresh AES-256 key, or adopt `--key`. Prints the key (share out-of-band) and its `kid` fingerprint (verify on the replica) |
| `enable --force` | Replace an existing key. **Warning:** already-synced ciphertext becomes undecryptable (kid mismatch) |
| `show` | Print the current key + `kid` for out-of-band sharing, or report that encryption is off |
| `disable` | Remove the key; future pushes send plaintext (already-synced ciphertext is unaffected) |

Provision the key on the origin, then clone a replica with the matching
`memorize project clone … --encryption-key <b64>`. A wrong key fails
closed: the clone-time pull throws a clear `kid` mismatch rather than
returning garbage. Key distribution UX (a host-level key store mirroring
#192's credential store, env fallback) is a follow-up; today the key
lives per project in `sync/remote.json`. Same experimental caveats as
`project sync`.

### `memorize auth (login | status | logout)` (experimental)

Host-scoped sync **credential store** (#192), the git-credential model:
authenticate once per Hub host, then `project clone`/`sync` over
`--remote-url` carry no inline `--token`. The token is **authorization**
(the Hub sees it), kept deliberately separate from the #182 encryption
key, which is **confidentiality** (the Hub never sees it) — the two are
never co-stored.

| Action | Purpose |
|---|---|
| `login --remote-url <url> [--token <t>] [--no-validate] [--no-browser] [--label <l>]` | Authenticate for the URL's host. On an interactive terminal with no `--token`, opens a **browser device-authorization** flow (see below); with `--token` (or the token piped on stdin, keeping it out of shell history) it stores that key directly — the bring-your-own-token / CI path. `--no-browser` skips the auto-open; `--label` names the minted key |
| `status [--remote-url <url>]` | With a URL, report whether a token is stored for that host; without, list all hosts that have one (never the tokens) |
| `logout --remote-url <url>` | Remove the stored token for the URL's host |

`memorize login` is an optional convenience **alias** for `memorize auth login`
(the namespaced form stays canonical, mirroring `gh auth login`).

`login` **validates** the token against the Hub before saving (a cheap
authenticated `GET {host}/healthz`) so a typo'd or expired key fails fast
here rather than as a deferred auto-sync failure later. Only a definitive
`401`/`403` aborts (nothing is stored); an unreachable or non-conformant Hub
degrades to "stored anyway" with a warning, so offline/CI provisioning still
works. Pass `--no-validate` to skip the network probe entirely.

**Browser login (device authorization).** Without `--token` on an interactive
terminal, `login` (and its alias `memorize login`) runs the RFC 8628 device
grant against the Hub instead of asking for a pasted key: it requests a code
(`POST /v1/device/code`), prints a short `user_code` + verification URL (and
opens the browser unless `--no-browser`), then polls `POST /v1/device/token` —
waiting through `authorization_pending`, backing off on `slow_down` — until you
approve in a browser already signed in to your Hub account and the Hub returns
the freshly-minted `mzk_` key. The key is then stored host-scoped `0600`,
exactly like the `--token` path. The wire contract is memorize_hub
`docs/protocol/device-auth.md`.

**WSL PATH interop pitfall.** WSL can inherit Windows PATH entries. If a
Windows global npm shim wins, Linux `node` may execute the memorize install
under `/mnt/c/...`; that crosses native modules (`better-sqlite3`) across OS
boundaries and can hang before printing an error. Install a Linux copy and make
sure it wins on PATH:

```sh
npm i -g @shakystar/memorize
hash -r
which memorize # must not print a /mnt/... path
```

Resolution order for the bearer token (most→least specific): explicit
`--token` → per-project persisted token (legacy state only) → this host store
→ the `MEMORIZE_SYNC_TOKEN` env escape hatch. **Anti-sprawl:** an explicit
`--token` passed to `project clone`/`sync` is written **through** to this host
store and is **not** persisted into per-project sync state — that config keeps
only `{ type, url }`, and auto-sync re-resolves the token host-side at runtime,
so the secret lives in exactly one place. Storage: a `0600` JSON file at
`MEMORIZE_ROOT/credentials` keyed by normalized host — plaintext at rest,
honest like git's `store` helper (an OS-keychain backend is the hardening
path). Same experimental caveats as `project sync`.

### `memorize project decision list [--all] [--json]`

Lists the project's decisions, newest first. By default it shows only the live
(accepted) set, the same decisions startup context carries. Pass `--all` to
also include superseded ones (preserved by design, never deleted). Read-only:
a pure projection read that writes no events. Human output is tab-separated
(`id\tstatus\ttitle`); `--json` emits the raw decision array.

| Flag | Shape | Purpose |
|---|---|---|
| `--all` | boolean | Include superseded decisions, not just the accepted set |
| `--json` | boolean | Emit the raw decision array instead of tab-separated lines |

### `memorize project decision show <id> [--json]`

Prints a single decision in full (title, decision, rationale, status, plus
`supersededBy` when it was replaced). Read-only. Fails with a clear error if
the id is unknown.

| Flag | Shape | Purpose |
|---|---|---|
| `<id>` | positional, required | The decision to print |
| `--json` | boolean | Emit the raw decision object instead of formatted text |

### `memorize project decision add --title <text> --decision <text> [--rationale <text>]`

Records an explicit project decision as a first-class event. The decision
joins the startup context and is contradiction-checked against existing
decisions exactly like a consolidated decision memory.

| Flag | Shape | Purpose |
|---|---|---|
| `--title <text>` | single, required | Short decision title |
| `--decision <text>` | single, required | The decision itself |
| `--rationale <text>` | single | Why it was made (recommended; feeds contradiction detection) |

### `memorize project decision supersede <oldDecisionId> --title <text> --decision <text> [--rationale <text>] [--reason <text>]`

Corrects/replaces a previously recorded decision, append-only, the way you
fix a decision in an event-sourced log. It records the replacement as a
brand-new accepted decision and appends a `decision.superseded` marker that
closes out the old one: the original decision is preserved (its status flips
to `superseded` and it gains `supersededBy`), so point-in-time replays still
see what was decided then, while `acceptedDecisionIds` automatically drops it
in favour of the replacement. Nothing is mutated or deleted. Fails if the
decision id is unknown or already superseded.

| Flag | Shape | Purpose |
|---|---|---|
| `<oldDecisionId>` | positional, required | The decision being superseded |
| `--title <text>` | single, required | Short title of the replacement decision |
| `--decision <text>` | single, required | The replacement decision itself |
| `--rationale <text>` | single | Why the replacement was made |
| `--reason <text>` | single | Why the old decision was superseded |

## Tasks & handoffs: the OPTIONAL explicit-coordination layer

Everything above this point (memory capture, consolidation, retrieval,
session visibility) is **ambient**: it works with zero ceremony, just by
agents doing their work. Tasks, handoffs, and checkpoints are a
different, **optional** layer: explicit coordination artifacts you
declare on purpose, claiming a piece of work so a parallel agent doesn't
grab it, handing a baton to the next agent with intent. A project with
busy sessions and an empty task list is NORMAL, not broken (#85);
never treat `task list` as the way to see what sessions are doing.
That is `memorize session activity`.

### `memorize task create "<title>" [flags]`

Appends a `task.created` event. Actor defaults to `user`. Title is the
positional argument and is required; unknown flags are rejected loudly
(they are never silently joined into the title).

| Flag | Shape | Purpose |
|---|---|---|
| `--goal <text>` | single | What "done" means, in one line |
| `--description <text>` | single | Longer context than the title |
| `--priority low\|medium\|high` | single | Default `medium` |
| `--ac <text>` | multi | Item added to `acceptanceCriteria` |

Fill `--goal` and `--ac` at creation when you already know them — they
are what `task resume` and the Hub task panel show the next agent.
`description`/`goal` are NOT defaulted from the title anymore: an empty
field stays empty instead of masquerading as filled. Questions and risks
discovered later are appended with `task update --question` / `--risk`.

### `memorize task list [flags]`

| Flag | Shape | Purpose |
|---|---|---|
| `--status <s>` | single | `todo` / `in_progress` / `blocked` / `handoff_ready` / `done` |
| `--workstream <id>` | single | Filter by workstream |

Output: tab-separated `id\tstatus\tpriority\ttitle`, sorted by
`createdAt` ascending. `No tasks found.` when the filter is empty.

### `memorize task show <taskId>`

Prints the task JSON.

### `memorize task start [<taskId>]`

Transitions the task to `in_progress` and prints the startup context
payload. Resolves the target like `handoff`/`done` (`--task` → the
session's claimed task → the active task). Idempotent when already
`in_progress` (no redundant event). Rejected on a terminal task
(`done`/`cancelled`). This is how an agent *claims* a task so a parallel
agent sees it is being worked on.

### `memorize task resume [<taskId>]`

Loads the startup context payload and prints it as JSON — a **pure read
that never changes status** (so reading another task's handoff with
`--task <id>` cannot flip its state). This is what an agent reads on
`SessionStart`.

- With no argument: targets the calling session's claimed task; if the
  session has none, the task is auto-selected (in_progress →
  handoff_ready → first).
- `<taskId>` (positional) or `--task <taskId>` (single): load the
  startup context for an explicit task instead.

Unknown flags are rejected on both verbs.

### `memorize task checkpoint --summary "<text>" [flags]`

Records a mid-session snapshot. **Mostly superseded**: boundary
consolidation now captures session state automatically (the old
PreCompact checkpoint flow is gone, #85). Reach for this only when you
want to pin an explicit, named snapshot the automatic distillation
would not preserve verbatim.

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

Records a handoff intent to the next agent. The handoff transitions the
task `in_progress → handoff_ready` through the state machine. A handoff
from `todo` is **rejected** — `start` the task first. A re-handoff of an
already-`handoff_ready` task is allowed (it refreshes the snapshot).

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

A handoff is an immutable snapshot. Before handing off, put questions
and risks that should stay visible on the task itself (Hub shows them as
the task's living state) with `task update --question` / `--risk` — the
handoff's own `--question` / `--warning` record the moment, not the
task's ongoing state.

### `memorize task update [<taskId>] [flags]`

#148: append-only correction of a task's title and/or note, plus
item-level appends to the task's living list fields. Corrections
**append** a `task.updated` event; each `--question` / `--risk` / `--ac`
item **appends** its own `task.item-appended` event (never a whole-array
patch, so two concurrent sessions can't clobber each other's items).
The original `task.created` event and every prior update stay in the log
untouched. Status changes are not permitted here; status has its own
verbs (`start` / `handoff` / `done` / `cancel`).

- `<taskId>` (positional) or `--task <taskId>` (single): the target;
  falls back to the session's claimed task, then the active task, the
  same way `task done` resolves.
- `--title <text>` (single): set the task title.
- `--note <text>` (single): set the task description.
- `--question <text>` (multi): append to `openQuestions`.
- `--risk <text>` (multi): append to `riskNotes`.
- `--ac <text>` (multi): append to `acceptanceCriteria`.
- At least one flag is required, else it errors.

`openQuestions` / `riskNotes` are the task's LIVING state — what a
teammate clicking the task (especially a `blocked` one) reads to learn
"why is this stuck". The handoff's `--question` / `--warning` capture a
moment-in-time snapshot instead; record in BOTH places when a question
should outlive the handoff. The natural moments to append here: when a
task becomes `blocked`, before a handoff, and at a checkpoint.

### `memorize task cancel [<taskId>]`

#148: drives a task to the terminal `cancelled` state by **appending** a
`task.updated` event (a correction, NOT a delete). The cancelled task
drops out of `activeTaskIds` and startup context because it is terminal,
but its full history remains in the immutable event log. Resolves the
target the same way `task update` / `task done` do. Cancelling an already
`done` task fails with an invalid-transition error (`done` is terminal
success).

| Flag | Shape | Purpose |
|---|---|---|
| `--task <taskId>` | single | Overrides the auto-selected task |

### `memorize task done [--task <taskId>]`

#118: drives a task to the terminal `done` state. Resolves the target
the same way `handoff` does (`--task` → the session's claimed task →
the active task) and fails if none resolves. Valid from `in_progress`
(a solo `start → done` finish, no handoff needed) or from `handoff_ready`
(the close-out after `task handoff`). Rejected from `todo` (nothing was
started).

| Flag | Shape | Purpose |
|---|---|---|
| `--task <taskId>` | single | Overrides the auto-selected task |

### `memorize setup`

Global onboarding for a human-run install (the `curl|sh` / `irm|iex`
one-liner calls it). Detects installed agents and wires the global parts:

- Detection: an agent counts as present if its config dir (`~/.claude`,
  `~/.codex`) exists or its launcher is on PATH.
- Codex: if present, writes the global hook to `~/.codex/hooks.json`
  (same as `install codex`). Idempotent.
- Claude: detection only; Claude hooks are per-project, so `setup` cannot
  wire them globally. Instead it plants the global `init-memorize` Agent
  Skill at `~/.claude/skills/init-memorize/SKILL.md`, so in any project the
  agent can be asked to "set up memorize" and will run `memorize init`.
- No agent detected: prints guidance and exits 0.

`setup` never touches the current working directory and never binds a
project; that is `project setup`'s (or `memorize init`'s) job. For
onboarding a specific project, prefer `memorize init` — it binds the
project AND wires the detected agent(s) in one step, where `setup` only
does the machine-global codex part. Test-only env override:
`MEMORIZE_DETECT_PATH` replaces the PATH scanned for agent launchers.

### `memorize mcp`

Runs the memorize **MCP server** over stdio — the cross-harness pillar. Any
MCP-capable host (Cursor, Cline, Goose, opencode, …) can wire it as an
`mcpServers` entry and call memorize without a per-harness hook adapter:

```json
{ "memorize": { "command": "npx", "args": ["-y", "@shakystar/memorize", "mcp"] } }
```

The server is cwd-scoped (it serves whatever project the launch directory binds
to) and exposes:

- `memorize_recall` — search the project brain for decisions/rationale/progress.
- `memorize_context` — the session-start context (active tasks, recent
  decisions, parallel-session activity). Also a `memorize://context` resource
  and a `session-context` prompt for hosts that prefer those surfaces.
- `memorize_record` — persist distilled decisions/rationale/progress (idempotent).
- `memorize_consolidate` — run a consolidation boundary (real side effect).
- `memorize_diagnose` — `doctor` as JSON.

Limit vs hooks: MCP tools/resources are pulled on-demand by the agent — they are
NOT auto-injected before the first turn the way a `SessionStart` hook is.
Deterministic pre-turn injection + automatic capture still need the hook pillar
(`install claude`); MCP is the universal fallback for hosts without a hook system.

Support tiers: **Claude Code is the first-class, conformance-gated harness.** The
other hook integrations (codex/opencode/gemini/pi/hermes/cursor) are **frozen** —
kept in-tree and still installable, but no longer covered by conformance CI and
may drift as those harnesses change upstream (community-maintained, PRs welcome).
This generic MCP server is the durable cross-harness surface for everything that
is not Claude.

### `memorize install claude`

Idempotent. Writes hook entries into `.claude/settings.local.json`
under the `hooks` map for these events:

- `SessionStart` → injects the startup context as `additionalContext`.
- `PostToolUse` → captures observations (CLS short-term memory).
- `PostCompact` → runs a memory-consolidation boundary.
- `SessionEnd` → closes the session (+ a final consolidation boundary).

Legacy `Stop` and `PreCompact` entries written by older versions are
stripped on re-install: Stop fired per-turn (not per-session), and
PreCompact's checkpoint capture was replaced wholesale by the
PostCompact consolidation boundary (#85).

Existing user hooks for the same events are preserved: memorize
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
and safe when nothing is installed. With no target (`memorize uninstall`) it
does both. Captured memory (events/projection under `MEMORIZE_ROOT`) is
NOT removed; uninstall undoes the editor integration, not the data.

### Optional: LLM extraction & semantic search (env)

All optional. With nothing configured, memory consolidation auto-detects
your agent CLI (`claude`, then `codex`) on PATH and extracts through its
existing login, no API key needed; with no CLI either, it falls back to
rule-based consolidation. Semantic search stays OFF unless configured
(FTS5 lexical search only). Point these at any OpenAI-compatible endpoint
(a cloud provider or a local Ollama) to enable richer features:

- `MEMORIZE_LLM_BACKEND`: `claude-cli` | `codex-cli` | `off`. Forces the
  host-CLI extractor (`claude -p` / `codex exec`, the user's existing
  subscription auth) or disables LLM extraction entirely (`off` =
  rule-based). Unset: an API key below wins, else CLI auto-detect.
- `MEMORIZE_LLM_ENDPOINT` / `MEMORIZE_LLM_API_KEY` / `MEMORIZE_LLM_MODEL`:
  LLM memory consolidation at boundaries, plus the semantic-contradiction
  judge. `MEMORIZE_LLM_API_KEY` must be set to enable it (use any dummy
  value, e.g. `ollama`, for a keyless local server).
- `MEMORIZE_LLM_TIMEOUT_MS`: LLM extraction timeout in milliseconds,
  for both the HTTP and host-CLI backends. Defaults are backend-specific:
  `20000` (HTTP) / `90000` (host-CLI, where `claude -p` cold start plus a real
  extraction takes tens of seconds). Raise it for local CPU models, which
  can need minutes per extraction.
- `MEMORIZE_CONSOLIDATE_INLINE`: set to `1` to run boundary consolidation
  synchronously inside the hook process instead of the default detached
  background child (slower boundaries, deterministic ordering).
- `MEMORIZE_CONSOLIDATE_THRESHOLD`: pending (un-consolidated) observation
  count that fires an automatic mid-session consolidation, in addition to
  the lifecycle boundaries (default `20`; `0` disables the mid-session
  trigger entirely). Debounced: at most one fire per consolidation
  watermark per 5 minutes.
- `MEMORIZE_EMBEDDINGS_ENDPOINT` / `MEMORIZE_EMBEDDINGS_API_KEY` /
  `MEMORIZE_EMBEDDINGS_MODEL`: embedding-based semantic search (hybrid
  with FTS5, used in both explicit `search` and startup injection) and the
  same-topic candidate step of contradiction detection. Enabled when the
  endpoint **or** key is set (a keyless local Ollama works with just the
  endpoint).
- `MEMORIZE_CONTRADICTION_MIN_SIMILARITY`: cosine pre-filter for
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
  re-install; Stop fires per-turn, not per-session, so the old
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
externally-written hooks (no error, no log) until you approve them
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
no-op (`{}`); memorize is silent there.

**Note: codex sandbox + memorize home directory.** memorize stores
project state under `~/.memorize/` (overridable via `MEMORIZE_ROOT`).
Codex's default workspace-write sandbox blocks writes outside the
project root, so memorize CLI invocations from inside a sandboxed
codex session (including the ones the agent itself runs to record
handoffs) will fail unless `~/.memorize/` is added to the sandbox's
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

### `memorize conflict list`

#148: prints the project's open conflicts as JSON. Bare `memorize
conflict` (no args) does the same. Any other first argument is rejected
with `Unknown conflict subcommand: <x>` rather than silently falling
through to the list (so a typo like `conflict resovle` errors instead of
printing the list).

### `memorize conflict resolve <id> [--summary <text>]`

Marks an open conflict resolved, appending a `conflict.resolved` event.
`<id>` (positional, required) is a conflict id from `memorize conflict
list`; `--summary <text>` (single) records how it was resolved. Resolving
a conflict that does not exist fails.

### `memorize search "<query>" [--limit N] [--lexical] [--json]`

Searches the bound project's memory (consolidated memories, tasks,
rules/topics). Hybrid by default: FTS5 lexical always, with semantic
reranking joining when an embeddings endpoint is configured;
`--lexical` (boolean) forces pure FTS. `--limit` (single) caps the hit
count. Query punctuation is treated literally; input is
injection-proof by construction.

### `memorize export [--out <file>]`

Streams the project's full event log as NDJSON: to `--out <file>`
(single) when given, else to stdout for piping. This is the
backup/inspection primitive: the event log is the only source of
truth, so an export IS a complete project backup.

### `memorize migrate` / `memorize migrate cleanup`

One-time migration of a legacy NDJSON event store (pre-SQLite layouts)
into `memorize.db`. The original files are kept as an `events.bak/`
safety net; `migrate cleanup` removes that backup once you trust the
migrated store. Both are idempotent and safe on already-migrated
projects (`doctor` tells you if a migration is pending).

### `memorize events validate`

Reads every event ndjson for the current project and reports corrupt
lines without throwing. Useful when `doctor` flagged integrity issues.

### `memorize projection rebuild`

Re-reduces the event log and rewrites every entity JSON. Idempotent;
safe to run at any time.

### `memorize memory-index rebuild`

Regenerates `memory-index.json` from the current projection. Usually
handled automatically after writes.

## Cross-project task requests (delegation)

Workspace sync shares every member project's context, but the BOUNDARY rule
is: an agent never performs work that belongs to another member project — it
delegates. If you find work that belongs to a different repo in this
workspace, register a request instead of doing it here:

    memorize workspace sources                       # who is addressable
    memorize task request "<title>" --to <project> \
      --goal "<why this is their work>" [--ac "<criterion>"]…

The request is pushed to the Hub immediately; the target project's next
session sees it in its startup payload (`inboundTaskRequests`) and MUST
resolve it explicitly:

    memorize task request list --inbound
    memorize task request accept <requestId>          # mints a LOCAL task
    memorize task request decline <requestId> --reason "<why>"

Decline reasons flow back to the requester. Do not ignore stale inbound
requests — decline them with the reason (e.g. "already shipped in #238"), so
the requester's outbound view (`task request list --outbound`) stops waiting.

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

The event log is stored in `memorize.db` under the active account store.
Do not look for `.memorize/<pid>/events/*.ndjson`; that layout is no
longer current.

Common domain event types:

- `project.created`, `project.updated`
- `workstream.created`
- `task.created`, `task.updated`
- `task.requested`, `task.request-accepted`, `task.request-declined`
- `handoff.created`
- `checkpoint.created`
- `decision.proposed`, `decision.accepted`
- `rule.upserted`
- `conflict.detected`, `conflict.resolved`
- `observation.captured`
- `memory.consolidated`, `memory.superseded`, `memory.retracted`

Each event wraps its payload under a `payload` field and includes
`id`, `projectId`, `scopeType`, `scopeId`, `actor`, and `createdAt`.
Workspace union events can also carry `writer` and `sourceProjectId`
so projections keep each member's provenance separate.

---

## When in doubt

1. Run `memorize doctor --json` first; the `checks[]` array tells
   you what the tool itself thinks is wrong.
2. Follow the `fix` field literally where one is suggested; each fix
   is a real command or action.
3. If a command fails in a way this guide does not cover, check the
   source under `src/cli/commands/` and `src/services/`; they are
   small files (100–200 lines each) and named after the command.
