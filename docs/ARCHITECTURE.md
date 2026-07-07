# Memorize architecture

Memorize gives coding agents one persistent project brain. It is local-first, event-sourced, and built around an optional Hub for remote coordination.

This is the technical companion to the [README](../README.md). For command behavior, read [AGENT_GUIDE.md](../AGENT_GUIDE.md).

---

## Current facts

- What: project, personal, and workspace memories are stored as append-only events and read through derived projections.
- Who: Claude Code is the first-class maintained harness. Other harnesses are installed on a frozen, best-effort basis.
- When: capture happens while the agent works; consolidation happens at session boundaries; retrieval happens at session start.
- Where: local data lives under `MEMORIZE_ROOT`, grouped by account. Hub data is used only for remote sync and control-plane state.
- Why: startup context must work offline and must not block on a network call.
- How: local SQLite stores hold events and projections; Hub stores route remote event sync by server-minted ids.

---

## Design principles

1. **Events are the source of truth.** Every task, handoff, decision, rule, observation, memory, and retraction is represented by an event. Projections, search indexes, and startup payloads are derived state.
2. **Local startup is not network-bound.** Session start reads local stores. Sync is additive and best-effort.
3. **Scopes are hard boundaries.** Project memory, personal memory, and workspace-shared memory are separate channels. They can be shown together, but they are not the same store.
4. **Remote ids are server-minted.** Local projects have `proj_` ids. Hub workspace stores use `wsp_`. Hub personal stores use `psm_`.
5. **Workspace identity is control-plane state.** `wsp_`, role, invite state, and membership come from Hub endpoints.
6. **Deletion is a tombstone first.** Retraction hides a memory by event. Physical garbage collection is explicit and limited to un-pushed local data.

Premise: the event log is authoritative. Premise: startup must work offline. Result: local stores are authoritative for startup, and remote state is synced into local stores before it can affect startup context.

---

## Store types

### Project store

A project store belongs to one local project identity, `proj_...`.

It contains:

- project events
- observations
- consolidated project memories
- task and handoff events
- decisions, rules, conflicts, and retractions
- derived projections and search indexes

The project store is the default source for `memorize task resume`, `memorize search`, `memorize memory list`, and startup project context.

### Personal store

A personal store belongs to one account, not to one project. It stores preferences and working-style facts that should follow the same user across projects.

The local personal store lives beside that account's projects. When synced through the Hub, it uses a server-minted `psm_...` store id. It never crosses accounts.

Personal memories are rendered in their own startup channel, `memorize.personal`.

### Workspace store

A workspace is a Hub-backed shared project surface. The Hub mints a `wsp_...` id and records membership and roles in its control plane.

The shared data plane is still event sync. Members exchange project events through the `wsp_...` store. A member's original `proj_...` remains as provenance through `sourceProjectId`.

Memories from other members are rendered in their own startup channel, `memorize.shared`.

---

## Memory pipeline

### Capture

During a session, hooks capture cheap observations. Examples:

- file writes
- mutating shell commands
- decision keywords
- task transitions

No LLM runs in capture. Capture appends events and returns quickly.

### Consolidation

At session boundaries, a detached process reads new observations and the transcript window since the last byte offset. It writes consolidated memories with:

- kind: `decision`, `rationale`, or `progress`
- text
- salience
- provenance
- optional lifecycle evidence, such as `obsoleteWhen` and tags

Extractor priority:

1. OpenAI-compatible HTTP endpoint
2. Host CLI, such as `claude -p` or `codex exec`
3. Rule-based fallback

Watermarks advance only after output events are durable. If extraction fails, the same window is retried later.

### Retrieval

At session start, candidates are ranked by salience, recency, reuse, and relevance. Retrieval has a fixed context budget. Memories that do not fit are not deleted; they simply lose that session's ranking.

The score shape is:

```text
long-term score = 0.7 * (0.5 * salience/10 + 0.5 * recency + relevance boost)
short-term score = 0.3 * recency
```

### Contradiction and retraction

When a newer memory contradicts an older memory, the older memory is superseded by event. When a user or owner retracts a memory, a `memory.retracted` event tombstones it.

Projection reads the events and hides invalid memories from normal list, search, and startup context. Audit data remains reconstructable.

---

## Multi-agent behavior

Parallel sessions in the same project share local work signals:

- active session status
- recent observations
- file-collision warnings
- late boundary memories from the current session

`memorize session activity` is the pull command for "what are my other sessions doing?" Startup and mid-session injection are the push paths.

---

## Sync and Hub

Hub sync is the canonical remote sync path. A public hosted Hub is live at https://memorize-hub-shakystar.fly.dev (open beta, free to join); you can also run your own.

Use it when:

- a project needs to move across machines
- a project needs a shared workspace
- a user wants same-account personal memory sync

The Hub has two planes:

- Control plane: accounts, credentials, workspaces, roles, membership, invites, and server-minted store ids.
- Data plane: opaque event sync by store id.

The relay does not parse event payloads. The client owns merge, projection, contradiction handling, and final retrieval ranking.

File transport through `--remote-path` still exists for existing users, but it is deprecated and frozen. New remote setup should use Hub sync.

---

## Storage layout

`MEMORIZE_ROOT` defaults to `<home>/.memorize`.

```text
<MEMORIZE_ROOT>/
  profile/
    bindings.json              # path to project binding hints
  credentials                  # host-scoped Hub credentials
  accounts/
    <accountId>/
      projects/
        <projectId>/
          memorize.db          # events, projections, FTS, embeddings, meta
          sync/
            remote.json        # remote binding, watermarks, workspace role cache
          topics/
            <topicId>.md       # imported rules as readable topics
      personal/
        memorize.db            # account personal memory store
        sync/
          remote.json          # psm_ binding when personal sync is enabled
        topics/
```

SQLite migrations use `PRAGMA user_version`. Projections are derived and can be rebuilt from events.

---

## Safety and trust

- Prompt-injection containment: replayed data is wrapped as data before injection.
- Hook trust: Codex requires one interactive approval before externally written hooks run.
- Credential locality: Hub tokens are host-scoped credentials, not project events.
- Startup locality: startup reads local stores first and does not require Hub reachability.
- Sync privacy boundary: personal memory sync is same-account only; workspace memory is available to workspace members by role.

---

## Reasoning rule

Use this rule when changing sync, workspace, or memory architecture:

1. Read the SoT documents first.
2. Identify the scope: project, personal, or workspace.
3. Identify the authority: local event log or Hub control plane.
4. Add events only for domain facts.
5. Use Hub endpoints for identity, membership, roles, and store routing.
6. Keep startup local-first.
