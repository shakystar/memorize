# Memorize

> Keep one project memory shared between you, Claude, and Codex — locally,
> as an append-only event log that replays into a fresh startup context
> every session.

Memorize stores tasks, handoffs, checkpoints, and workstream state as
events on disk, projects them into startup payloads for each agent, and
installs thin hooks so that Claude Code or Codex automatically loads that
context at session start.

## Why

- **Claude sessions end and the context dies with them.** Next session,
  you re-explain what you were doing, what you decided, and where you
  stopped.
- **Switching from Claude to Codex means starting over.** Each agent has
  its own memory shape, and none of them see the other's notes.
- **Rules docs drift.** `CLAUDE.md` / `AGENTS.md` get copy-pasted between
  projects until nobody knows what is authoritative.

Memorize treats the project itself as the memory. Events are the source
of truth; projections and agent bootstraps are cheap to rebuild. The same
event log feeds Claude and Codex, so a handoff you wrote during one
session is visible to whichever agent picks up next.

## Set it up (5 seconds, your AI does it)

Memorize is designed to be installed **by** your AI coding assistant, not
by you. Send your Claude Code or Codex session a single prompt:

> Set up memorize in this project. Follow the instructions at
> https://github.com/shakystar/memorize#for-ai-assistants

The assistant will add the package, bind the directory, install the
correct agent hook, and verify the install. Once it reports success, use
`claude` / `codex` as you always do — the startup context is injected
automatically at session start.

Verify any time with:

```sh
npx memorize doctor
```

## Working directory

- Run memorize commands from anywhere inside your project — memorize
  walks up from the current directory to find the nearest bound project
  (same behaviour as git).
- `.memorize/` under your project holds per-project runtime state
  (current session, bootstrap files). **Add `.memorize/` to your
  `.gitignore`**; `doctor` warns if it is not.
- The durable event log lives under `~/.memorize/` by default.
  Override with the `MEMORIZE_ROOT` environment variable if you want a
  different location.

## Day-to-day commands

You rarely need these — your AI drives most interactions. The ones you
might reach for as a human:

```sh
memorize doctor            # diagnose project + integration state
memorize project show      # print bound project summary (JSON)
memorize task list         # list tasks (use --status to filter)
memorize task resume       # load startup context for the current task
memorize task handoff ...  # record a handoff to the next agent
```

Run `memorize` on its own for the usage overview, or
`memorize <cmd> --help` for a specific command. Every other command
(setup, install, hook, projection rebuild, sync, etc.) is documented in
[AGENT_GUIDE.md](./AGENT_GUIDE.md) — your AI reads that file when it
needs detail.

## Troubleshooting

- `No project bound to current directory.` — run `memorize project setup`
  from the project root. It is idempotent and imports your existing
  `AGENTS.md` / `CLAUDE.md` / `.cursorrules`.
- Claude session shows no memorize context — run `memorize doctor` and
  follow the `fix:` field of any failing check. Usually re-running
  `memorize install claude` clears it.
- Task list is empty although you created tasks — run
  `memorize project show` to confirm the project id matches; you may be
  inside a different bound project.
- Completely remove memorize from a project:
  - delete `.memorize/` in your project
  - delete the memorize hooks from `.claude/settings.local.json`
  - delete the memorize hook entries from `~/.codex/hooks.json`
    (if you ran `install codex`)
  - optionally `rm -rf ~/.memorize` to clear durable state across
    all projects

## For AI assistants

You are Claude Code, Codex, or another AI coding assistant and the user
asked you to set up memorize in this project. Follow these steps
exactly. Every command is idempotent — if a step fails partway, re-run
it; do not hand-edit `.memorize/` or the generated config files.

### Ground rule: memorize is the single source of truth

**Do NOT record memorize state in your own memory system.** Memorize
is the authoritative store for project id, tasks, handoffs, rules,
and conflicts. If you maintain your own long-term memory (Claude Code
`MEMORY.md`, Cursor saved context, etc.), **do not duplicate
memorize-tracked data there**. Query memorize at session start
instead:

```sh
npx @shakystar/memorize task resume
```

Storing a project id in your own memory goes stale the moment the
user re-runs `project setup` or wipes `~/.memorize/`, and silently
breaks cross-session consistency. This has bitten real users.
The only thing worth recording in your own memory is "memorize is
installed in this project; always query it for state" — **no ids,
no task lists, no summaries.**

1. **Make `memorize` available on PATH.** Pick the path that matches the
   project:

   - **Node project (has `package.json`)** — install as a dev dependency
     so the bin lands in `node_modules/.bin`:

     ```sh
     pnpm add -D @shakystar/memorize
     # or: npm install -D @shakystar/memorize
     # or: yarn add -D @shakystar/memorize
     ```

   - **Non-Node project (no `package.json` or you do not want to add
     one)** — install globally so the hooks installed in step 3 can
     invoke `memorize` directly:

     ```sh
     npm install -g @shakystar/memorize
     ```

   Do **not** skip this step and rely on bare `npx memorize` — the
   hook commands installed in step 3 are invoked by Claude Code / Codex
   from their own process, and will fail if `memorize` is not resolvable
   via `npx @shakystar/memorize` (which works after either install
   mode).

2. **Adopt the project**:

   ```sh
   npx @shakystar/memorize project setup
   ```

   This binds the current directory to a memorize project (creating one
   if needed) and imports any existing `AGENTS.md`, `CLAUDE.md`,
   `GEMINI.md`, `.cursorrules`, and files under `.cursor/rules/` as
   rules. Safe to re-run.

   (Do not use `memorize project init` for adoption — it creates a
   fresh project without importing rules and refuses to run on an
   already-bound directory.)

3. **Install your agent integration**. Pick the one that matches you:

   ```sh
   npx @shakystar/memorize install claude    # if you are Claude Code
   npx @shakystar/memorize install codex     # if you are Codex
   ```

   Both commands are safe to re-run and preserve unrelated content in
   the target files.

   - `install claude` writes hook entries to `.claude/settings.local.json`
     (per-project).
   - `install codex` writes hook entries to `~/.codex/hooks.json`
     (global — codex stores hooks per-user, not per-project). Memorize
     entries are prepended so they run before any other registered
     hooks; this is how memorize guarantees it is the source of truth
     even when other orchestration layers (OMX, etc.) are installed.
     The codex hook is a no-op in directories that are not bound to a
     memorize project.

4. **Verify**:

   ```sh
   npx @shakystar/memorize doctor --json
   ```

   Expected: exit code `0` and `"status": "ok"`. If `status` is `warn`
   or `error`, apply the `fix` field of each issue in order and re-run
   until status is `ok`.

5. **Tell the user** briefly:

   > Memorize is set up. Your project context will persist across
   > sessions. Create your first task with
   > `memorize task create "<title>"` or let me do it next time you
   > describe work.

### Full command reference

For every command's flags, behaviour, idempotency guarantees, failure
modes, and the on-disk layout memorize writes to, read
[AGENT_GUIDE.md](./AGENT_GUIDE.md) in this repository. The file is also
bundled inside the npm tarball, so it is available offline.

### Command index (1-line summaries)

```
project setup        bind cwd + import AGENTS/CLAUDE/.cursorrules
project show         print bound project JSON
project sync         push/pull events to a remote path
install claude       wire hooks into .claude/settings.local.json
install codex        wire hook entries into ~/.codex/hooks.json
task create          append task.created event
task list            list tasks with optional --status/--workstream
task show            print task JSON
task resume          render startup context for current task
task checkpoint      record mid-session snapshot
task handoff         record handoff to next agent
doctor [--json]      diagnose project and integration state
conflict list        list open conflicts as JSON
events validate      verify event log integrity
projection rebuild   re-reduce events into projections
memory-index rebuild regenerate memory index from projection
hook claude <Event>  internal hook entry (called by Claude Code)
project init         low-level "create fresh project" (rarely needed)
```

## Status

Memorize is in a `0.x` alpha. Expect API iteration until `1.0.0`. The
event log schema is versioned and projections are regenerable, so
upgrades should not require manual data migration within a major
version.

## Contributing

Developer workflow (not needed for users):

```sh
pnpm install
pnpm dev -- project setup         # run the CLI from source
pnpm build                        # produce dist/ for `memorize` bin
pnpm qa:full                      # typecheck + lint + unit + integration + golden
```

## License

Released under the [MIT License](./LICENSE). Copyright (c) 2026
shakystar.

"Memorize" and the Memorize logo are unregistered trademarks of
shakystar. The MIT License grants you permission to use, modify, and
redistribute the source code, but does not grant permission to use
these marks in the name of a derivative product, fork, or service in a
way that could cause confusion about origin or endorsement. Factual
references ("built on Memorize") are welcome.

## Security

See [SECURITY.md](./SECURITY.md) for how to report vulnerabilities
privately.
