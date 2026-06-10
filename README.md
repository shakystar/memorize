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

## Install

Two ways in. **Most people should use the first** — memorize is built to
be installed by your AI assistant, per project.

### Recommended — let your AI set it up

Send your Claude Code or Codex session a single prompt:

> Set up memorize in this project. Follow the instructions at
> https://github.com/shakystar/memorize/blob/main/guides/AI_SETUP.md

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
  - `memorize uninstall claude` and/or `memorize uninstall codex` —
    removes the memorize hooks (and any integration blocks) while
    preserving your other hooks/config. Idempotent. Your captured memory
    is left intact.
  - delete `.memorize/` in your project to drop per-project runtime state
  - optionally `rm -rf ~/.memorize` to clear the durable event log across
    all projects — this is the only step that deletes captured memory

## For AI assistants

If you are an AI coding assistant and the user asked you to set memorize
up, follow [guides/AI_SETUP.md](./guides/AI_SETUP.md) — the idempotent
setup steps and the ground rule (memorize is the single source of truth;
do not duplicate its state in your own memory). For the full command
behaviour, flags, and on-disk layout, see
[AGENT_GUIDE.md](./AGENT_GUIDE.md).

## Status

Memorize is on the `2.x` line (AGPL-3.0-or-later since 2.0.0). The
compatibility promise covers:

- The on-disk event log layout (`<MEMORIZE_ROOT>/projects/<pid>/...`)
  and the per-project `.memorize/` directory shape.
- The day-to-day CLI surface listed above.
- The hook contracts written by `install claude` and `install codex`.

Within a major line we will not break those. The event log is versioned
and projections are regenerable, so upgrades within a major version do
not require manual data migration.

**Experimental** (subject to change in a minor release):

- `memorize project sync [--push|--pull|--bind|--remote-path]` — the file
  transport works and is roundtrip-tested; the HTTP relay client ships
  but needs a separate relay server (forthcoming). Do not depend on the
  wire format yet.
- The observe-only lifecycle-evidence fields on consolidated memories
  and the `consolidate --report` shape (#57/#62) — instrumentation that
  may change as the taxonomy decision lands.

See [CHANGELOG.md](./CHANGELOG.md) for release history.

## Contributing

Developer workflow (not needed for users):

```sh
pnpm install
pnpm dev -- project setup         # run the CLI from source
pnpm build                        # produce dist/ for `memorize` bin
pnpm qa:full                      # typecheck + lint + unit + integration + golden
```

## License

Released under the [GNU Affero General Public License v3.0](./LICENSE)
(AGPL-3.0). Copyright (c) 2026 shakystar.

AGPL-3.0 keeps memorize open: you may use, modify, and redistribute it,
but **derivative works and network/SaaS deployments must make their
complete corresponding source available under the same license**. This
prevents memorize from being absorbed into a closed-source product or a
hosted service without giving back. (Versions 1.0.0–1.1.0 were released
under the MIT License and remain available under those terms.)

"Memorize" and the Memorize logo are unregistered trademarks of
shakystar. The license grants permission to use, modify, and redistribute
the source code, but does not grant permission to use these marks in the
name of a derivative product, fork, or service in a way that could cause
confusion about origin or endorsement. Factual references ("built on
Memorize") are welcome.

## Security

See [SECURITY.md](./SECURITY.md) for how to report vulnerabilities
privately.
