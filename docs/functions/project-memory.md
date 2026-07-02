# Project memory

## What

Project memory is the persistent memory for one project. It records decisions, rationale, progress, tasks, handoffs, rules, conflicts, observations, and memory retractions.

## Who

Project memory is read by AI agents working in the bound project directory. Humans usually interact with it through commands such as `memorize search`, `memorize session activity`, and `memorize project show`.

## When

- Capture happens during tool use.
- Consolidation happens at session boundaries.
- Retrieval happens at session start.
- Search happens on demand.

## Where

Project events and projections live in the account-scoped project store:

```text
<MEMORIZE_ROOT>/accounts/<accountId>/projects/<projectId>/memorize.db
```

## Why

An agent session has limited context and can end at any time. Project memory gives later sessions the decisions and stopping point without requiring the user to repeat them.

## How

1. Hooks capture cheap observations.
2. A detached consolidation process turns observations and transcript text into memories.
3. Startup rendering selects the highest-value memories within a context budget.
4. Retractions and supersedes hide invalid memories without deleting the audit trail.

## Commands

```sh
memorize memory import --source <label>
memorize memory list
memorize memory show <memoryId>
memorize memory retract <memoryId>
memorize memory revert --session <sessionId>
memorize memory gc --dry-run
memorize search <query>
memorize consolidate
```

## Rule

Project decisions, project progress, project constraints, and project handoffs belong here. User preferences do not.
