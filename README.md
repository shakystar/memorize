# Memorize

> Keep one project memory shared between you, Claude, and Codex — locally, as
> an append-only event log that replays into a fresh startup context every
> session.

Memorize is a local-first shared context system. It stores tasks, handoffs,
checkpoints, and workstream state as events on disk, projects them into
startup payloads for each agent, and installs thin hooks so that Claude Code
or Codex automatically loads that context at session start.

## Why

- **Claude sessions end and the context dies with them.** Next session, you
  re-explain what you were doing, what you decided, and where you stopped.
- **Switching from Claude to Codex means starting over.** Each agent has its
  own memory shape, and none of them see the other's notes.
- **Rules docs drift.** `CLAUDE.md` / `AGENTS.md` get copy-pasted between
  projects until nobody knows what is authoritative.

Memorize treats the project itself as the memory. Events are the source of
truth; projections and agent bootstraps are cheap to rebuild. The same event
log feeds Claude and Codex, so a handoff you wrote during one session is
visible to whichever agent picks up next.

## 60-second quickstart

```sh
# 1. Install (requires Node 20.10+)
pnpm add -D @shakystar/memorize
# or: npm install -D @shakystar/memorize

# 2. Create a project binding in the current directory
npx memorize project init

# 3. Wire up your agent
npx memorize install claude   # or: install codex

# 4. Verify
npx memorize doctor --json
```

After `install`, launch your agent normally — the installed hook or bootstrap
block takes over and injects Memorize's startup payload on session start.

## How it works

```
event log  ─►  projection  ─►  startup payload  ─►  agent session
   ▲                                                    │
   └──────────── handoffs / checkpoints ◄───────────────┘
```

- **Event log** (`.memorize/<project-id>/events/`): append-only, per-project
  JSON records. Every task, handoff, checkpoint, and workstream transition is
  an event. Nothing is mutated in place.
- **Projection** (`.memorize/<project-id>/projections/`): cached view
  rebuilt from events. Safe to delete and regenerate.
- **Startup payload**: a compact bundle the launch hook renders into whatever
  format Claude or Codex expects at session start.
- **Install targets**: `install claude` writes hook commands into
  `.claude/settings.local.json`; `install codex` adds a versioned managed
  block to `AGENTS.override.md`. Both are idempotent — re-running them
  converges to the same state.

## Common commands

```sh
memorize project init              # bind current dir to a new project
memorize project show              # print the bound project summary (JSON)
memorize task create "<title>"     # add a task to the project
memorize task list                 # list tasks (use --status open|done|all)
memorize task start                # start the next task
memorize task handoff              # record a handoff intent to another agent
memorize do "<sentence>"           # natural-language intent routing
memorize doctor                    # human-readable health check
memorize doctor --json             # structured health report for automation
memorize launch claude             # start Claude with bootstrap injection
memorize launch codex              # start Codex with bootstrap injection
memorize project sync --push       # push events to a remote transport
```

Run `memorize` with no arguments for the full command index.

## For AI assistants

If you are Claude Code, Codex, or another AI coding assistant and the user
asked you to set up Memorize in this project, follow these steps exactly.
Every command below is idempotent — if a step fails partway, re-run it; do
not hand-edit `.memorize/` or the generated config files.

1. **Add the package** to the project as a dev dependency:

   ```sh
   pnpm add -D @shakystar/memorize
   # or: npm install -D @shakystar/memorize
   # or: yarn add -D @shakystar/memorize
   ```

2. **Initialize the project binding**:

   ```sh
   npx memorize project init
   ```

   This creates `.memorize/<project-id>/` under the current directory's home
   and binds the directory to that project. Safe to re-run.

3. **Install your agent integration**. Pick the one that matches you:

   ```sh
   npx memorize install claude    # if you are Claude Code
   npx memorize install codex     # if you are Codex
   ```

   - `install claude` adds hook commands to `.claude/settings.local.json`
     (`SessionStart`, `PreCompact`, `PostCompact`, `Stop`). Existing hooks
     are preserved.
   - `install codex` writes a managed block to `AGENTS.override.md`
     delimited by `<!-- memorize:bootstrap v=1 start -->` /
     `<!-- memorize:bootstrap v=1 end -->`. Content outside the markers is
     preserved.
   - Both commands are safe to re-run; re-running will not duplicate
     content or break unrelated edits.

4. **Verify the install**:

   ```sh
   npx memorize doctor --json
   ```

   Expected: exit code `0` and `"status": "ok"` in stdout. If `status` is
   `warn` or `error`, read the `issues` array and apply the `fix` field from
   each issue before continuing. Example failing response:

   ```json
   {
     "status": "error",
     "checks": [...],
     "issues": [
       { "id": "project.bound", "severity": "error",
         "fix": "memorize project init" }
     ],
     "version": "1"
   }
   ```

   The schema is stable within major versions: field additions are
   non-breaking; field removals and renames are not.

5. **Tell the user** in one short message:

   > Memorize is set up. Your project context will now persist across
   > sessions. Create a first task with `memorize task create "<title>"`.

### What gets created

- `.memorize/<project-id>/` — event log, projections, and sync metadata.
  Recommend gitignoring `.memorize/`.
- `.claude/settings.local.json` (Claude install only) — hook commands merged
  into the existing file.
- `AGENTS.override.md` (Codex install only) — managed block appended or
  refreshed.

### Failure recovery

- `install` failing partway: just re-run the same command. Both Claude and
  Codex install paths are transactional at the file level.
- `doctor` reporting `error`: apply the `fix` from each issue in order, then
  re-run `doctor --json` until status is `ok`.
- Do not manually edit files under `.memorize/`. If the directory becomes
  inconsistent, delete it and re-run `memorize project init` — the event
  log is the only source of truth and other state is regenerable.

## Status

Memorize is in a structured prototype phase. Expect API and behavior
iteration until the `1.0.0` release. The event log schema is versioned and
projections are regenerable, so upgrades should not require manual data
migration within a major version.

Current capabilities:

- project / workstream / task domain model
- append-only event log
- projection and memory index rebuild
- Claude and Codex startup context renderers
- `launch` wrappers with auto-setup bootstrap
- `memorize do` sentence-level intent routing
- project-scoped sync metadata and file-transport round-trip
- fixture / golden / benchmark validation assets

## Contributing

Developer workflow (not needed for users):

```sh
pnpm install
pnpm dev -- project init          # run the CLI from source
pnpm build                        # produce dist/ for `memorize` bin
```

QA scripts:

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test` (unit + integration)
- `pnpm test:smoke`
- `pnpm test:golden`
- `pnpm qa:quick` / `pnpm qa:full`
- `pnpm benchmark:all`

## License

Released under the [MIT License](./LICENSE). Copyright (c) 2026 shakystar.

"Memorize" and the Memorize logo are unregistered trademarks of shakystar.
The MIT License grants you permission to use, modify, and redistribute the
source code, but does not grant permission to use these marks in the name
of a derivative product, fork, or service in a way that could cause
confusion about origin or endorsement. Factual references
("built on Memorize") are welcome.

## Security

See [SECURITY.md](./SECURITY.md) for how to report vulnerabilities privately.
