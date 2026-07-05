<p align="center">
  <img src="https://github.com/user-attachments/assets/a674a964-d875-4439-87db-8c18ad8222da" alt="memorize: shared memory for AI coding agents" width="720">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@shakystar/memorize"><img src="https://img.shields.io/node/v/%40shakystar%2Fmemorize" alt="node"></a>
  <a href="https://github.com/shakystar/memorize/actions/workflows/ci.yml"><img src="https://github.com/shakystar/memorize/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@shakystar/memorize"><img src="https://img.shields.io/npm/dm/%40shakystar%2Fmemorize" alt="downloads"></a>
  <a href="https://discord.com/channels/1523335804804661348"><img alt="Discord" src="https://img.shields.io/discord/1523335804804661348"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license"></a>
</p>

<p align="center">
  <a href="./AGENT_GUIDE.md">Agent Guide</a> ·
  <a href="./docs/ARCHITECTURE.md">Architecture</a> ·
  <a href="./guides/AI_SETUP.md">Setup</a> ·
  <a href="https://github.com/shakystar/memorize/issues">Issues</a> ·
  <a href="https://github.com/shakystar/memorize/discussions">Discussions</a>
</p>

---

Sharable persistent memory for Claude Code and Codex.

Memorize records what your coding agent does — file writes, decisions, commands — distills it into long-term memory, and injects the right context when the next session starts. It is local-first and works offline; an optional Hub adds cross-machine and team sync.

## Highlights

- **Never re-explain.** Decisions, rationale, and progress survive session death and agent switches.
- **No API key required.** Consolidation rides your existing `claude` or `codex` login, any OpenAI-compatible endpoint, or a rule-based fallback.
- **No server, no ports.** A stateless CLI invoked by hooks; nothing to keep alive.
- **Nothing is ever lost.** Append-only event log; forgetting happens at retrieval time, and projections can always be rebuilt.
- **Zero-LLM capture.** The capture hot path is rule-based — no tokens spent, no latency added while you work.
- **Three clean channels.** Project, personal, and shared workspace memory stay separate by construction.
- **Team- and machine-ready.** The optional Hub syncs event logs across machines and workspace members.

## Install

Node.js 22.9 or newer is required.

**Recommended — let your AI install it.** Memorize is built to be installed by your AI assistant, per project. Send your Claude Code or Codex session a single line:

> Follow this guide to set up memorize in this project: https://github.com/shakystar/memorize/blob/main/guides/AI_SETUP.md

The assistant adds the package, binds the directory, installs the correct hook, asks whether to absorb existing project context, and verifies the install. After that you use `claude` or `codex` as usual. Context arrives automatically when a session opens.

**By hand.** [AI_SETUP.md](./guides/AI_SETUP.md) has the manual route for putting `memorize` on your PATH and wiring hooks yourself.

**Check any time:**

```sh
npx @shakystar/memorize doctor
```

**From source.** See [CONTRIBUTING.md](./.github/CONTRIBUTING.md) for the pnpm workspace setup and developer workflow.

## Usage


```sh
memorize doctor            # diagnose project and integration state
memorize update            # upgrade the CLI and refresh integrations machine-wide
memorize session activity  # what are my other sessions doing?
memorize consolidate       # run one memory-consolidation boundary now
memorize search <query>    # search project memory
memorize project show      # print the bound project summary (JSON)
```

Every other command lives in [AGENT_GUIDE.md](./AGENT_GUIDE.md), which your AI reads when it needs the detail.

> **Support tiers**: only `Claude Code` is the fully maintained target for now. The other harness integrations — Codex, opencode, Gemini CLI, pi, Hermes, and Cursor — are frozen: still installable, but no longer covered by conformance CI.

> Any MCP-capable host can also use the generic [`memorize mcp`](./AGENT_GUIDE.md) server.

## Collaborate through the Hub

Memorize is local-first, but its bigger goal is **shared team memory**: the same append-only log syncs across a team so every teammate's agent opens from the same context. To achieve this...

### 🧪 [**memorize-hub-shakystar.fly.dev**](https://memorize-hub-shakystar.fly.dev) is live! — join freely as a beta tester.

The full workspace, role, and sync surface is in [AGENT_GUIDE.md](./AGENT_GUIDE.md).

## Docs by goal

| You want to… | Read |
| --- | --- |
| Install memorize in a project | [guides/AI_SETUP.md](./guides/AI_SETUP.md) |
| Look up any command, flag, or failure mode | [AGENT_GUIDE.md](./AGENT_GUIDE.md) |
| Understand the memory design | [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) |
| Contribute code | [CONTRIBUTING.md](./.github/CONTRIBUTING.md) |
| Report a security issue | [SECURITY.md](./SECURITY.md) |


## Comparison

| | **memorize** | agentmemory | Built-in (`CLAUDE.md`) |
| --- | --- | --- | --- |
| Storage model | Append-only event log (SQLite) + rebuildable projections | Mutable KV file store + live streams | Static markdown file |
| Retrieval R@5 (LongMemEval-S) | **0.978** hybrid / 0.966 lexical — reproduce with `pnpm benchmark:retrieval` | 0.952 (published) | — (no retrieval) |
| Capture | Automatic hooks, rule-based — no LLM in the hot path | Automatic hooks, synthetic compression by default | Manual editing |
| Consolidation without an API key | Yes — logged-in `claude`/`codex` CLI, any OpenAI-compatible endpoint, or rule-based fallback | LLM compression requires an API key | — |
| Search | BM25 (FTS5) + optional semantic, RRF fusion | BM25 + vector + graph, RRF fusion (vector requires embedder setup) | — |
| Forgetting | Retrieval-time only — nothing is ever deleted, supersedes are recoverable | TTL-based eviction (hard delete) | Manual |
| Conflict handling | LLM-judge contradiction detection with a deterministic winner | Lexical-similarity contradiction check | — |
| Multi-machine / team | Event-log sync through the optional Hub; deterministic convergence | HTTP mesh, last-write-wins | Copy files by hand |
| Runtime footprint | Stateless CLI — no daemon, no open ports | Always-on server stack (REST, stream, and viewer ports) | None |
| Agent support | Claude Code first-class; Codex + 5 more (frozen tier); generic MCP server | 20+ agents, MCP + REST | Claude Code |

> Pinned to agentmemory v0.9.27 (June 2026) and checked against both codebases rather than marketing copy. Benchmark harnesses differ between projects, so treat cross-project retrieval numbers as directional; memorize's numbers are reproducible in this repo.

### Retrieval benchmark

Retrieval is scored on [LongMemEval-S](https://github.com/xiaowu0162/longmemeval), a public 500-question memory benchmark. Each question buries its answer in one of roughly fifty past chat sessions; we load those sessions into memorize and check whether the right one comes back.

| mode | recall@5 | recall@10 | recall@20 | ndcg@10 | mrr |
| --- | --- | --- | --- | --- | --- |
| lexical (BM25) | 0.966 | 0.986 | 0.994 | 0.896 | 0.911 |
| hybrid (BM25 + bge-m3) | 0.978 | 0.994 | 1.000 | 0.925 | 0.932 |

These are retrieval-recall scores, not answer accuracy, and they test the search layer rather than the consolidation layer. Reproduce with `pnpm benchmark:retrieval bm25`.


## Community

Issues and discussions are open to everyone. Bug reports, design debates, and usage questions are welcome.

- File bugs and concrete feature requests in [Issues](https://github.com/shakystar/memorize/issues).
- Take design directions and open-ended ideas to [Discussions](https://github.com/shakystar/memorize/discussions).

See [CONTRIBUTING.md](./.github/CONTRIBUTING.md) for the developer workflow.
