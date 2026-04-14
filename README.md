# Memorize

Memorize is a local-first shared context system for human and AI collaboration.

## License

Memorize is released under the [MIT License](./LICENSE).
Copyright (c) 2026 shakystar.

## Trademarks

"Memorize" and the Memorize logo are unregistered trademarks of shakystar.
The MIT License applies to the source code only and does not grant permission
to use these marks in the name of a derivative product, fork, or service in a
way that could cause confusion about origin or endorsement. Factual references
(for example, "built on Memorize") are welcome.

## Security

See [SECURITY.md](./SECURITY.md) for how to report vulnerabilities privately.

Current prototype capabilities:
- project/workstream/task domain model
- append-only event log
- projection rebuild and memory index generation
- thin CLI-first workflow
- Claude/Codex startup context renderers
- Claude/Codex launch wrappers with auto-setup bootstrap
- sentence-level `memorize do` command routing
- project-scoped sync metadata foundation
- fixture/golden/benchmark validation assets

## Current commands

### Project
- `pnpm dev -- project init`
- `pnpm dev -- project setup`
- `pnpm dev -- project show`
- `pnpm dev -- project sync`

### Launch
- `pnpm dev -- launch claude`
- `pnpm dev -- launch codex`

### Task
- `pnpm dev -- task create <title>`
- `pnpm dev -- task show <taskId>`
- `pnpm dev -- task start`
- `pnpm dev -- task resume`

### Other
- `pnpm dev -- conflict`
- `pnpm dev -- do "Set this project up for Claude and Codex collaboration"`
- `pnpm dev -- do "Create a task for auth cleanup"`
- `pnpm dev -- do "Summarize project status"`

## QA commands

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm test:unit`
- `pnpm test:integration`
- `pnpm test:smoke`
- `pnpm test:golden`
- `pnpm qa:quick`
- `pnpm qa:full`
- `pnpm benchmark:all`

## Status

Memorize is in a structured prototype phase. Expect rapid iteration on APIs
and behavior until the `1.0.0` release.
