# Setting up Memorize (for AI assistants)

You are Claude Code, Codex, or another AI coding assistant and the user
asked you to set up memorize in this project. This file is the **setup
quickstart**: the exact, idempotent steps to get memorize running.

For the full behaviour, flags, idempotency guarantees, failure modes,
and on-disk layout of every command, read
[AGENT_GUIDE.md](../AGENT_GUIDE.md). This file gets you installed; that
file is the reference you consult afterwards.

Follow these steps exactly. Every command is idempotent: if a step
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
installed in this project; always query it for state": **no ids,
no task lists, no summaries.**

## Setup steps

1. **Make `memorize` available on PATH.** Pick the path that matches the
   project:

   - **Node project (has `package.json`)**: install as a dev dependency
     so the bin lands in `node_modules/.bin`:

     ```sh
     pnpm add -D @shakystar/memorize
     # or: npm install -D @shakystar/memorize
     # or: yarn add -D @shakystar/memorize
     ```

     In a **pnpm workspace monorepo**, a plain `pnpm add` at the root
     fails with `ERR_PNPM_ADDING_TO_ROOT`; add it to the workspace root
     with `pnpm add -D -w @shakystar/memorize`, or install globally
     (`npm install -g @shakystar/memorize`, see the next bullet). If a
     `node_modules` was linked from another machine's pnpm store you may
     hit `ERR_PNPM_UNEXPECTED_STORE`; reinstall to rebuild the local
     store. With a global install, the step 3 hooks must still resolve
     the `memorize` binary, and `doctor` (step 4) flags it if they cannot.

   - **Non-Node project (no `package.json` or you do not want to add
     one)**: install globally so the hooks installed in step 3 can
     invoke `memorize` directly:

     ```sh
     npm install -g @shakystar/memorize
     ```

   Do **not** skip this step and rely on bare `npx memorize`. The
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

   (Do not use `memorize project init` for adoption: it creates a
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
     (global; codex stores hooks per-user, not per-project). Memorize
     entries are prepended so they run before any other registered
     hooks; this is how memorize guarantees it is the source of truth
     even when other orchestration layers (OMX, etc.) are installed.
     The codex hook is a no-op in directories that are not bound to a
     memorize project.
   - **Codex only: tell the user to approve the hooks once.** Codex
     silently skips externally-written hooks (no error, no log) until
     the user approves them in an interactive codex session. After
     `install codex`, instruct the user: "start `codex` interactively
     once and accept the hook approval prompt; until then memorize
     records nothing from codex sessions." `memorize doctor` warns
     when registered hooks have apparently never fired. (Upstream
     fix tracked in openai/codex#21615.)

4. **Verify**:

   ```sh
   npx @shakystar/memorize doctor --json
   ```

   Expected: exit code `0` and `"status": "ok"`. If `status` is `warn`
   or `error`, apply the `fix` field of each issue in order and re-run
   until status is `ok`.

5. **Enable consolidation & semantic search** (optional but recommended).
   Out of the box, memory consolidation auto-detects your agent CLI
   (`claude`, then `codex`) on PATH and extracts through its existing
   login. If no CLI is detected (and whenever `MEMORIZE_LLM_BACKEND=off`),
   it drops to a degraded rule-based extractor, and a boundary with no
   real extractor reports `extractor: "none"` and consolidates nothing of
   substance. **Until a backend is configured or auto-detected,
   consolidation is effectively a no-op.** Pin it explicitly so you do not
   depend on auto-detect:

   - **Extractor (zero extra download via the Claude CLI / OAuth you
     already have):**

     ```sh
     MEMORIZE_LLM_BACKEND=claude-cli
     ```

     Accepted values: `claude-cli`, `codex-cli`, `off` (`off` =
     rule-based, no LLM). This reuses the host CLI's existing
     subscription auth: no API key, no endpoint.

   - **Embeddings for semantic search** (otherwise `search` is FTS5
     lexical only). Point these at any OpenAI-compatible `/v1` endpoint,
     e.g. a local Ollama:

     ```sh
     MEMORIZE_EMBEDDINGS_ENDPOINT=http://localhost:11434/v1/embeddings
     MEMORIZE_EMBEDDINGS_MODEL=bge-m3
     MEMORIZE_EMBEDDINGS_API_KEY=ollama
     ```

     The key may be any dummy value for a keyless local server (it is
     sent as `Authorization: Bearer <value>`). `bge-m3` (1024-dim) was
     verified to give accurate Korean semantic search; swap in any model
     your endpoint serves.

   - **Verify it is actually on:** run
     `npx @shakystar/memorize doctor` and read the
     `Memory consolidation health` (`consolidation.health`) check. Once
     a boundary has run, its last attempt reports the resolved backend
     (e.g. `via cli:claude`), not `rule-based`/`none`.

   **Make the env reach the hooks (required).** Consolidation and
   embedding run *inside* the hooks, which Claude Code / Codex execute in
   a **non-interactive** shell that does **not** source `~/.bashrc` /
   `~/.bash_profile`. Hooks inherit the agent process's environment, not
   your interactive shell rc. `export MEMORIZE_LLM_BACKEND=...` in
   `.bashrc` will NOT reach a hook.

   - **Windows:** set persistent **User** environment variables (System
     Properties, then Environment Variables, or `setx MEMORIZE_LLM_BACKEND
     claude-cli`), then **restart the agent** so it inherits them.
     `setx` does not affect the already-running process, so a restart is
     required.
   - **macOS / Linux:** set the vars where the agent process itself
     inherits them (your login environment / the context that launches
     the agent), not just an interactive shell rc.

   See the AGENT_GUIDE.md section "Optional: LLM extraction & semantic
   search (env)" for the full variable list (timeouts, contradiction
   detection, the `MEMORIZE_LLM_ENDPOINT` HTTP backend, etc.).

6. **Offer to absorb pre-existing context** (mid-project adoption, #69).
   If this project lived under you (or another agent) before memorize
   (your harness memory has project notes, or the user keeps decision
   docs), offer:

   > This project has existing context (my session memory / your docs).
   > Want me to distill it into memorize so every future session starts
   > with it?

   If the user accepts:

   1. Ask which sources: your own harness memory (you know its path),
      `CLAUDE.local.md` / `AGENTS.override.md`, and any doc folders the
      user names (ADRs, plans, postmortems).
   2. Read and distill **project state only**: decisions, constraints,
      progress, rationale. Your per-self content (user preferences, your
      own work-style lessons) STAYS in your harness memory. One
      self-contained sentence per item; include `obsoleteWhen` for
      items with a natural expiry and 1–3 free-form `tags`.
   3. Pipe the JSON array to
      `npx @shakystar/memorize memory import --source <label>`
      (one invocation per source label, e.g. `claude-memory`,
      `docs/adr`; ≤100 items each).
   4. Report the result counts (`imported` / `skippedDuplicates`) to
      the user. Re-running is safe; duplicates are skipped.

7. **Tell the user** briefly:

   > Memorize is set up. Your project context will now persist across
   > sessions automatically. Just work as usual, and each new session
   > starts with the project's memory. Ask me "what are my other
   > sessions doing?" any time (`memorize session activity`).

   Do NOT tell the user to create a task: tasks are an optional
   explicit-coordination layer, and an empty task list is normal (#85).

## Recovering a failed install

If the user pastes an install error (from the one-line installer or the
steps above), diagnose in THIS order. Each step's failure mode is
distinct and the order avoids chasing symptoms:

1. **Node present and >= 22?** `node -v`. If missing/old, the user must
   install from https://nodejs.org; do not work around it.
2. **Global npm directory writable?** `npm root -g` then check write
   access. On stock Linux installs it is root-owned and `npm install -g`
   dies with EACCES. Apply the npm-recommended fix, NEVER sudo:
   `mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global`, add
   `export PATH="$HOME/.npm-global/bin:$PATH"` to the shell profile,
   re-run the installer.
3. **Binary resolvable?** `command -v memorize` (or `where.exe` on
   Windows). After a global install the CURRENT shell may not see the
   new PATH; a new terminal usually fixes it. On Windows, confirm
   `npm prefix -g` is on PATH.
4. **WSL shadowing**: inside WSL, `which memorize` returning a
   `/mnt/c/...` path means the WINDOWS install is leaking through PATH;
   install inside WSL (steps above) and ensure the Linux npm bin dir
   precedes `/mnt/c` entries in PATH.
5. **Everything installed but unhealthy?** Run
   `npx @shakystar/memorize doctor --json` and apply each issue's `fix`
   field in order until status is `ok`. Hooks load at session start, so
   the user must start a NEW agent session to see injected context.

If none of that resolves it, gather `node -v`, `npm -v`,
`npm prefix -g`, OS/shell, the full error output, and the doctor JSON,
and file an issue with the "Install failure" template, then tell the
user you did so.

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
memory import        ingest agent-distilled memories (stdin JSON array)
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
