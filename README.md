<p align="center">
  <img src="https://raw.githubusercontent.com/shakystar/memorize/main/.github/assets/social-preview.png" alt="memorize: shared memory for AI coding agents" width="720">
</p>

# Memorize: shared memory for AI coding agents

[![npm](https://img.shields.io/npm/v/%40shakystar%2Fmemorize)](https://www.npmjs.com/package/@shakystar/memorize)
[![CI](https://github.com/shakystar/memorize/actions/workflows/ci.yml/badge.svg)](https://github.com/shakystar/memorize/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](./LICENSE)

**English** | [한국어](./docs/i18n/README.ko.md)

> One persistent project brain shared between you, Claude Code, and Codex. No server, no API key, fully local, and modeled on how human memory actually works.

Your agent forgets everything when the session ends. What it was doing, what it decided and why, where it stopped. You explain all of it again next session. Memorize watches the agent work, distills what mattered into long-term memory, and feeds the right memories back when the next session opens. It does this for every agent on the project, across machines, with no server.

## 30-second install

Memorize is built to be installed by your AI assistant, per project. Send your Claude Code or Codex session a single line.

> Follow this guide to set up memorize in this project: https://github.com/shakystar/memorize/blob/main/guides/AI_SETUP.md

The assistant adds the package, binds the directory, installs the correct hook, asks whether to absorb your existing context (its own session memory, your decision docs) into memorize, then verifies the install. After that you use `claude` or `codex` exactly as before, and context arrives automatically when a session opens.

Check any time:

```sh
npx @shakystar/memorize doctor
```

(Always use the scoped name with npx. The unscoped `memorize` on npm is an unrelated package.)

If you would rather put `memorize` on your PATH by hand, [AI_SETUP.md](./guides/AI_SETUP.md) has the manual route. Node.js 22 or newer is required.

## What your agent sees at session start

```text
# Memorize context

Ground rule: memorize is the single source of truth for project state …

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
Recent work signals (prior session tail):
- [write-tool/Edit] src/hooks/useRemoteCursor.ts
- [decision-keyword/Bash] git commit -m "remove inner throttle"
```

No re-explaining. The next agent, any agent on any machine, picks up exactly here.

## Evidence from real usage

These numbers come from three days of unsupervised, hands-off dogfooding.

- **654 of 667 captured observations became memories**, a 98% conversion rate.
- **117 memories were injected 407 times across sessions.** The most-used ones (commit hashes, field names) showed up 19 to 21 times each, exactly the things an engineer would track by hand.
- **29 stale facts were replaced automatically by newer ones.** Nothing is write-and-forget; memory stays curated over its lifetime.
- **The overhead is roughly 0.25% of coding tokens**, and up to 1.8% at a conservative ceiling.
- **Capture, consolidation, replacement, and injection all run with no human in the loop.**
- **When parallel sessions touch the same file, a warning fires on the spot.**

### Retrieval benchmark

Beyond live usage, we score retrieval on [LongMemEval-S](https://github.com/xiaowu0162/longmemeval), a public 500-question memory benchmark. Each question buries its answer in one of roughly fifty past chat sessions. We load those sessions into memorize and check whether the right one comes back.

| mode | recall@5 | recall@10 | recall@20 | ndcg@10 | mrr |
| --- | --- | --- | --- | --- | --- |
| lexical (BM25) | 0.966 | 0.986 | 0.994 | 0.896 | 0.911 |
| hybrid (BM25 + bge-m3) | 0.978 | 0.994 | 1.000 | 0.925 | 0.932 |

Lexical search alone puts the right session in the top five for 96.6% of questions. Semantic search adds the most where the question and the session use different words, like preferences and paraphrased facts, and it ranks the right session higher. These are retrieval-recall scores, not answer accuracy, and they test the search layer rather than the consolidation that sits above it. Reproduce with `pnpm benchmark:retrieval bm25`.

## Why

- **When a Claude session ends, the context dies with it.** Next session you re-explain what you were doing, what you decided, and where you stopped.
- **Switching from Claude to Codex means starting over.** Each agent keeps its own memory, and none of them see the others' notes.
- **Two machines means half a brain in each.** The context piled up on your desktop does not follow you to the laptop.

## How it works

1. **Capture.** While the agent works, hooks record only cheap, rule-filtered observations (file writes, decisions, task transitions). No LLM, no latency.
2. **Consolidate.** At session boundaries a detached background process distills the observations and the conversation itself into long-term memory (decisions, rationale, progress) and scores each by salience. The extractor runs through the `claude` or `codex` login you already have, so no API key is needed. An OpenAI-compatible endpoint or a rule-based fallback works too.
3. **Retrieve.** When the next session opens, memories compete for a context budget. The ranking is salience times recency (a 14-day half-life, reinforced on reuse) times relevance to the current task. Forgetting happens only at retrieval time; nothing is ever deleted.
4. **Share.** Parallel sessions see each other's work live, including file-collision warnings. The same event log syncs across machines and converges deterministically. When memories contradict each other, the conflict is detected and resolved: the newer one wins, and the older stays reconstructable.

The deeper story lives in [ARCHITECTURE.md](./docs/ARCHITECTURE.md): the two-layer CLS memory design, watermark-idempotent consolidation, retrieval-time forgetting, and the lifecycle-evidence program that evolves the schema using dogfooding data.

## Every agent, every machine

Memorize is not tied to one agent. Claude Code and Codex share the same project brain, and your desktop and laptop read the same event log. There is no server, no central API, and no vendor lock-in. Everything is local-first and event-sourced.

> **Support tiers.** Claude Code is the first-class, fully maintained target. The other harness integrations (Codex, opencode, Gemini CLI, pi, Hermes, Cursor) are **frozen**: kept in the tree and still installable, but no longer covered by conformance CI and not guaranteed to keep pace with upstream changes — community-maintained, fixes welcome via PR. Any MCP-capable host can also use the generic [`memorize mcp`](./AGENT_GUIDE.md) server.

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

## Limits and roadmap

Here is the honest state of what is verified so far. Every item is on the near-term roadmap.

- **Confirmed at three-day scale.** Performance at months and hundreds of memories is not proven yet.
- **Embedding-based search is validated on the benchmark above, not yet in long-run production use.**
- **Decision capture leans toward file writes and commands** (99.8% of signals). Catching explicit decision keywords is in progress.

Embedding search and decision capture are the next things we are building.

## For AI assistants

If you are an AI coding assistant and the user asked you to set memorize up, follow [guides/AI_SETUP.md](./guides/AI_SETUP.md). It has the idempotent setup steps, the absorption flow for pre-existing context, and the ground rule (memorize is the single source of truth, and you do not duplicate its state in your own memory). Full command behavior is in [AGENT_GUIDE.md](./AGENT_GUIDE.md).

## Status

Memorize is on the `2.x` line (AGPL-3.0-or-later since 2.0.0). The compatibility promise covers the on-disk event-log layout, the day-to-day CLI above, and the hook contracts written at install time. Within a major line those will not break. The event log is versioned and projections are regenerable, so upgrades within a major version need no manual data migration.

## Community

Issues and discussions are open to everyone. Bug reports, design debates, and "how do I…" questions are all welcome.

- File bugs and concrete feature requests in [Issues](https://github.com/shakystar/memorize/issues).
- Take design directions and open-ended ideas to [Discussions](https://github.com/shakystar/memorize/discussions) (the memory-taxonomy debates live there).

See [CONTRIBUTING.md](./.github/CONTRIBUTING.md) for the developer workflow.

## License

AGPL-3.0-or-later. See [LICENSE](./LICENSE).
