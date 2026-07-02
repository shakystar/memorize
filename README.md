<p align="center">
  <img src="https://raw.githubusercontent.com/shakystar/memorize/main/.github/assets/social-preview.png" alt="memorize: shared memory for AI coding agents" width="720">
</p>

# Memorize: shared memory for AI coding agents

[![npm](https://img.shields.io/npm/v/%40shakystar%2Fmemorize)](https://www.npmjs.com/package/@shakystar/memorize)
[![CI](https://github.com/shakystar/memorize/actions/workflows/ci.yml/badge.svg)](https://github.com/shakystar/memorize/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](./LICENSE)

**English** | [한국어](./docs/i18n/README.ko.md)

> One persistent project brain shared by you, Claude Code, Codex, and your machines.

Your agent loses the session context when the session ends. It forgets what it was doing, what it decided, why it decided it, and where it stopped. Memorize records the useful work signals, distills them into long-term memory, and injects the right context when the next session starts.

Memorize is local-first. Project and personal memory live on your machine and work offline. When you want more than one machine or more than one person, an optional Hub provides sync, workspace identity, invites, and membership. Local startup never waits on the network.

## 30-second install

Memorize is built to be installed by your AI assistant, per project. Send your Claude Code or Codex session a single line.

> Follow this guide to set up memorize in this project: https://github.com/shakystar/memorize/blob/main/guides/AI_SETUP.md

The assistant adds the package, binds the directory, installs the correct hook, asks whether to absorb existing project context, and verifies the install. After that you use `claude` or `codex` as usual. Context arrives automatically when a session opens.

Check any time:

```sh
npx @shakystar/memorize doctor
```

Always use the scoped name with npx. The unscoped `memorize` on npm is an unrelated package. If you would rather put `memorize` on your PATH by hand, [AI_SETUP.md](./guides/AI_SETUP.md) has the manual route. Node.js 22 or newer is required.

## What your agent sees at session start

```text
# Memorize context

Ground rule: memorize is the single source of truth for project state.
Project: Realtime whiteboard MVP
Task: Fix cursor jitter on remote drag
Latest handoff: from codex. "Repro narrowed to the throttle in
  useRemoteCursor; failing test added in cursor-sync.test.ts"
Consolidated memories:
- [decision/s9] WebSocket transport chosen over WebRTC for v1. Simpler
  infra; revisit only if >200ms RTT becomes common
- [rationale/s7] Cursor positions are sent unthrottled on purpose; the
  jitter came from double-throttling, not bandwidth
- [progress/s5] LAN sync verified; jitter reproduces only above 80ms RTT
Recent work signals:
- [write-tool/Edit] src/hooks/useRemoteCursor.ts
- [decision-keyword/Bash] git commit -m "remove inner throttle"
```

No re-explaining. The next agent can resume from the recorded project state.

## Evidence from real usage

These numbers come from three days of unsupervised, hands-off dogfooding.

- **654 of 667 captured observations became memories**, a 98% conversion rate.
- **117 memories were injected 407 times across sessions.** The most-used ones, like commit hashes and field names, showed up 19 to 21 times each.
- **29 stale facts were replaced by newer ones.** Memory is curated over its lifetime.
- **The overhead is roughly 0.25% of coding tokens**, and up to 1.8% at a conservative ceiling.
- **Capture, consolidation, replacement, and injection all run without human intervention.**
- **When parallel sessions touch the same file, a warning fires during the work.**

### Retrieval benchmark

Beyond live usage, we score retrieval on [LongMemEval-S](https://github.com/xiaowu0162/longmemeval), a public 500-question memory benchmark. Each question buries its answer in one of roughly fifty past chat sessions. We load those sessions into memorize and check whether the right one comes back.

| mode | recall@5 | recall@10 | recall@20 | ndcg@10 | mrr |
| --- | --- | --- | --- | --- | --- |
| lexical (BM25) | 0.966 | 0.986 | 0.994 | 0.896 | 0.911 |
| hybrid (BM25 + bge-m3) | 0.978 | 0.994 | 1.000 | 0.925 | 0.932 |

Lexical search alone puts the right session in the top five for 96.6% of questions. Semantic search helps most when the question and the session use different words, such as preferences and paraphrased facts. These are retrieval-recall scores, not answer accuracy, and they test the search layer rather than the consolidation layer. Reproduce with `pnpm benchmark:retrieval bm25`.

## Why

- **When a Claude session ends, the context dies with it.** Next session you re-explain the work, decisions, and stopping point.
- **Switching from Claude to Codex means starting over.** Each agent keeps its own memory unless the project has a shared project brain.
- **Two machines split the project brain.** Desktop context does not automatically follow the laptop.

## How it works

1. **Capture.** While the agent works, hooks record cheap, rule-filtered observations: file writes, decisions, commands, and task transitions. No LLM runs in this path.
2. **Consolidate.** At session boundaries, a detached background process distills observations and conversation text into long-term memories: decisions, rationale, and progress. The extractor can use the `claude` or `codex` login you already have, an OpenAI-compatible endpoint, or a rule-based fallback.
3. **Retrieve.** When the next session opens, memories compete for a context budget. Ranking combines salience, recency, reuse, and relevance to the current task. Forgetting happens at retrieval time; the event log remains append-only.
4. **Share.** Parallel sessions share live work signals and file-collision warnings. Optional Hub sync lets machines and workspace members exchange event logs. Workspace memories from other members appear in a separate shared context channel.
5. **Separate.** Project memory, personal memory, and shared workspace memory are separate channels. Personal memory follows the same account across projects and can sync only through the account's personal Hub store. It is not mixed into a project workspace.

The deeper story lives in [ARCHITECTURE.md](./docs/ARCHITECTURE.md): the two-layer CLS memory design, watermark-idempotent consolidation, retrieval-time forgetting, account-scoped storage, and Hub workspace sync.

## Local-first, optional Hub

Memorize is not tied to one agent. Claude Code and Codex can read the same project memory, and multiple sessions in the same checkout can see each other's work. The local store works without a server.

The Hub is used when there is a remote coordination job:

- sync a project across machines
- create a workspace
- invite or remove members
- route a shared workspace store by its server-minted `wsp_` id
- route a personal memory store by its server-minted `psm_` id

> **Support tiers.** Claude Code is the first-class, fully maintained target. The other harness integrations, including Codex, opencode, Gemini CLI, pi, Hermes, and Cursor, are frozen: kept in the tree and still installable, but no longer covered by conformance CI and not guaranteed to keep pace with upstream changes. Fixes are welcome via PR. Any MCP-capable host can also use the generic [`memorize mcp`](./AGENT_GUIDE.md) server.

## Day-to-day commands

You rarely need these; your AI drives most of the interaction. The ones a human might reach for:

```sh
memorize doctor            # diagnose project and integration state
memorize update            # upgrade the CLI and refresh integrations machine-wide
memorize session activity  # what are my other sessions doing?
memorize consolidate       # run one memory-consolidation boundary now
memorize search <query>    # search project memory
memorize project show      # print the bound project summary (JSON)
```

Every other command lives in [AGENT_GUIDE.md](./AGENT_GUIDE.md), which your AI reads when it needs the detail.

## Current scope

Memorize has these current surfaces:

- Project memory: per-project event log, consolidation, search, startup injection, task state, handoffs, decisions, and conflict records.
- Personal memory: account-scoped memory for preferences and working-style facts, stored outside any project and surfaced in its own startup channel.
- Workspace memory: optional Hub-backed shared project memory, routed by `wsp_`, with membership and role data in the Hub control plane.
- Sync: canonical remote sync through the Hub. The file transport remains available for existing users but is deprecated and frozen.
- Storage: account-scoped stores under `MEMORIZE_ROOT`, with SQLite as the project event log and derived projection store.

## Status

The 3.0 line is the local-first plus optional Hub line. Local stores remain authoritative for startup context. Hub state is used for remote routing, credentials, workspace membership, and same-account personal sync. The event log is append-only, migrations are versioned, and derived projections can be rebuilt from the log.

## Community

Issues and discussions are open to everyone. Bug reports, design debates, and usage questions are welcome.

- File bugs and concrete feature requests in [Issues](https://github.com/shakystar/memorize/issues).
- Take design directions and open-ended ideas to [Discussions](https://github.com/shakystar/memorize/discussions).

See [CONTRIBUTING.md](./.github/CONTRIBUTING.md) for the developer workflow.

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE).
