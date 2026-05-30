# Setting up Memorize (for AI assistants)

You are Claude Code, Codex, or another AI coding assistant and the user
asked you to set up memorize in this project. This file is the **setup
quickstart**: the exact, idempotent steps to get memorize running.

For the full behaviour, flags, idempotency guarantees, failure modes,
and on-disk layout of every command, read
[AGENT_GUIDE.md](../AGENT_GUIDE.md) — this file gets you installed; that
file is the reference you consult afterwards.

Follow these steps exactly. Every command is idempotent — if a step
fails partway, re-run it; do not hand-edit `.memorize/` or the generated
config files.

## Ground rule: memorize is the single source of truth

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

## Setup steps

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

## Full command reference

For every command's flags, behaviour, idempotency guarantees, failure
modes, and the on-disk layout memorize writes to, read
[AGENT_GUIDE.md](../AGENT_GUIDE.md) in this repository. The file is also
bundled inside the npm tarball, so it is available offline.

## Command index (1-line summaries)

```
setup                detect installed agents + wire global integration
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
