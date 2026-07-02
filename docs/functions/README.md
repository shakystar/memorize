# Memorize function pages

These pages are draft source material for a future docs hub. They describe what Memorize does now. They are not a changelog.

Read in this order:

1. [Project memory](./project-memory.md)
2. [Personal memory](./personal-memory.md)
3. [Workspace sharing](./workspace-sharing.md)
4. [Sync and storage](./sync-and-storage.md)
5. [Agent integration](./agent-integration.md)

## Current surfaces

- Project memory keeps project state across sessions.
- Personal memory keeps account-scoped user facts across projects.
- Workspace sharing lets members exchange project memory through a Hub workspace.
- Sync and storage keep local startup authoritative while Hub handles remote coordination.
- Agent integration wires Claude Code first, with frozen best-effort support for other harnesses.

## Reasoning rule

Premise: startup context must work offline.

Premise: project, personal, and workspace data have different access boundaries.

Result: Memorize stores each channel separately and merges them only when rendering local startup context.
