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

## See it in 30 seconds

<!-- TODO: replace with asciinema embed once examples/quickstart.sh is recorded for the README. -->

The full demo is committed as a runnable script:
[examples/quickstart.sh](./examples/quickstart.sh). It spins up a throwaway
project, sets memorize up, creates a task, prints the startup payload an
agent would see, and records a checkpoint — all in a temporary directory
that is cleaned up on exit.

```sh
bash examples/quickstart.sh
```

## Install

Two ways in. **Most people should use the first** — memorize is built to
be installed by your AI assistant, per project.

### Recommended — let your AI set it up

Send your Claude Code or Codex session a single prompt:

> Set up memorize in this project. Follow the instructions at
> https://github.com/shakystar/memorize/blob/main/docs/AI_SETUP.md

The assistant adds the package, binds the directory, installs the correct
agent hook, and verifies the install. Once it reports success, use
`claude` / `codex` as you always do — the startup context is injected
automatically at session start.

Verify any time with:

```sh
npx memorize doctor
```

### Manual — put `memorize` on your PATH yourself

<details>
<summary>One-line install (global binary + <code>memorize setup</code>)</summary>

```sh
# macOS / Linux / WSL
curl -fsSL https://raw.githubusercontent.com/shakystar/memorize/main/scripts/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/shakystar/memorize/main/scripts/install.ps1 | iex
```

This installs the global binary, then runs `memorize setup`, which detects
Claude Code and Codex. Codex integration is wired globally on the spot;
Claude hooks are per-project, so `setup` tells you to run
`memorize install claude` inside each project you want memorize in.

Requires Node.js >= 22. The installer checks and tells you where to get it
if it is missing.

</details>

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

If you are an AI coding assistant and the user asked you to set memorize
up, follow [docs/AI_SETUP.md](./docs/AI_SETUP.md) — the idempotent
setup steps and the ground rule (memorize is the single source of truth;
do not duplicate its state in your own memory). For the full command
behaviour, flags, and on-disk layout, see
[AGENT_GUIDE.md](./AGENT_GUIDE.md).

## Status

Memorize is at `1.0.0-rc.0` — first release candidate. The 1.0
compatibility promise covers:

- The on-disk event log layout (`<MEMORIZE_ROOT>/projects/<pid>/...`)
  and the per-project `.memorize/` directory shape.
- The day-to-day CLI surface listed above.
- The hook contracts written by `install claude` and `install codex`.

Within the 1.x line we will not break those. The event log is versioned
and projections are regenerable, so upgrades within a major version do
not require manual data migration.

**Experimental** (subject to change in a 1.x minor release):

- `memorize project sync [--push|--pull|--bind|--remote-path]`. The file
  transport works and is roundtrip-tested, but real cross-machine
  dogfooding is post-1.0. Use it for local experimentation; do not
  depend on the wire format yet.

See [CHANGELOG.md](./CHANGELOG.md) for what landed in this RC.

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
