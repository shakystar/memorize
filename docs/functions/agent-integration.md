# Agent integration

## What

Agent integration installs hooks so an AI agent can receive startup context and emit work observations.

## Who

Claude Code is the first-class maintained harness. Codex and other harnesses remain installable but are frozen and best-effort.

## When

Install once per project with `memorize init`. Re-run it when project context files or hook files need repair.

## Where

- Claude Code hook config: `.claude/settings.local.json`
- Codex hook config: `~/.codex/hooks.json`
- Ground rule block: `CLAUDE.md` or `AGENTS.md`

## Why

Agents need context at session start, not after the user has re-explained the project. Hooks put the local startup payload into the agent runtime automatically.

## How

1. `memorize init` binds the current directory to a project.
2. It imports project context files as rules.
3. It detects installed harnesses.
4. It writes hook config for detected harnesses.
5. `memorize doctor` verifies the binding and integration state.

## Commands

```sh
memorize init
memorize doctor --json
memorize install claude
memorize install codex
memorize update
```

## Rule

Do not duplicate project state in an agent's own memory. At session start, query Memorize with `memorize task resume` and `memorize project show`.
