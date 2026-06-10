# Memorize architecture

How memorize gives N coding agents (Claude Code, Codex, …) one shared,
persistent project brain — locally, with no server, modeled loosely on
how biological memory actually works.

This is the technical companion to the [README](../README.md). For
command-level reference, see [AGENT_GUIDE.md](../AGENT_GUIDE.md).

---

## Design principles

1. **Events are the only source of truth.** Every task, decision,
   handoff, observation, and memory is an append-only event in a
   per-project SQLite log. Everything else — projections, search
   indexes, startup payloads — is a cache that can be deleted and
   rebuilt by replay.
2. **Forgetting without deletion.** Nothing is ever deleted. Memories
   get *invalidated* (their validity window closes) or simply lose the
   retrieval-score competition. "What was true then" stays
   reconstructable point-in-time.
3. **Expensive work happens at boundaries, never per-turn.** Capture is
   cheap rule-based filtering; the LLM runs only at session boundaries
   (and detached in the background, so it never blocks the agent).
4. **Zero-config first, evidence-gated complexity.** Works with no API
   key (host-CLI extractor through your existing agent subscription,
   rule-based fallback below that). Architectural upgrades (HLC clocks,
   incremental projections, retry layers) are explicitly gated on
   *observed* problems, not speculation.
5. **One self per agent, one brain per project.** Vendor harness memory
   is per-self (one agent × one machine); memorize is the shared brain.
   The ground rule planted at install time keeps project state in the
   shared brain and personal lessons in the agent's own memory.

---

## The two-layer memory system (CLS)

Memorize's memory pipeline borrows the complementary learning systems
structure of the brain: a fast, cheap episodic layer and a slow,
semantic long-term layer, connected by consolidation.

### Short-term: observations (the hippocampus analog)

While an agent works, PostToolUse hooks capture **observations** —
which tool fired, why the decision-signal filter admitted it, a locator
into the transcript. No LLM is involved at capture time; admission is
rule-based (file writes, mutating shell commands, decision keywords,
task transitions). Observations are append-only events like everything
else.

Functionally they decay fast: only the most recent 20 within 24 hours
are even candidates for context injection, at a low layer weight.
Physically they persist forever — auditable, re-consolidatable.

### Consolidation: the boundary distillation

At session boundaries (SessionStart catch-up, PostCompact, SessionEnd —
or `memorize consolidate` by hand) a **detached background child**
distills accumulated observations into **consolidated memories**:
`decision | rationale | progress`, each with a salience score 1–10 and
provenance (the observation ids it was distilled from).

The extractor is pluggable, in priority order:

1. **HTTP** — any OpenAI-compatible endpoint (cloud or local Ollama).
2. **Host CLI** — `claude -p` / `codex exec` through the user's
   existing subscription auth: the highest-quality zero-setup path. A
   recursion guard env var keeps the spawned CLI's own hooks inert.
3. **Rule-based** — no LLM at all; modest but never worse than nothing.

Correctness contract: the consolidation **watermark** advances only
after events are durably appended. A timeout, HTTP error, or
unparseable LLM reply propagates *without* advancing it, so the next
boundary retries the same window — failed extractions are never
silently lost. Watermark loss itself is survivable: a dedup guard on
observation provenance prevents re-consolidating history into
duplicates. Every attempt (success and failure) is recorded and
surfaced by `memorize doctor`.

### Long-term: retrieval-time forgetting

Injection candidates are ranked in a single pool:

```
long-term score  = 0.7 × (0.5·salience/10 + 0.5·recency + relevance boost)
short-term score = 0.3 × recency
```

- **Recency** decays exponentially with a 14-day half-life.
- **Reinforcement**: injected memories get an access stamp that resets
  their decay reference — re-referenced memories live longer
  (reactivation–reconsolidation).
- **Relevance boost**: FTS match against the current task title, or a
  graded semantic-similarity boost when embeddings are configured —
  whichever is stronger.
- A character budget (4,000 chars inside the ~8,000-char startup
  context) takes the best-scoring entries; everything else simply
  doesn't make the cut *this session*. Forgetting is retrieval-time
  only.

### Contradiction: invalidate, don't delete

When consolidation finds that a new memory contradicts an old one
(extractor-flagged, or detected semantically: embedding cosine as a
*recall-only* candidate filter, an LLM judge as the only decider —
cosine similarity is structurally blind to negation, so it is never
trusted to judge), the newer memory wins and the older one's validity
window is closed by a `memory.superseded` event. A `conflict.detected`
event surfaces the fork to the agents. Deterministic winner selection
(`(createdAt, id)` tuple) means every replica converges to the same
truth after sync.

---

## Multi-agent, multi-machine

### Real-time share (parallel sessions)

Sessions in the same project see each other mid-session: sibling
observations (self-filtered), file-collision warnings ("a sibling
touched the file you're editing"), and — deliberately *not*
self-filtered — the session's **own** late boundary memories, which
land seconds after a boundary thanks to detached consolidation and are
new information to the still-running session. A per-session watermark
guarantees nothing is injected twice.

### Cross-machine sync

The event log is a true replica: `project sync` (file transport, or the
HTTP relay client) merges logs, and **pure, content-keyed convergence
rules** make every replica agree without coordination — duplicate
memories distilled concurrently on two machines collapse to the same
deterministic winner everywhere; contradiction resolution picks the
same survivor on every replica. No central server, no clocks trusted
beyond a tie-break (a hybrid logical clock upgrade is designed and
deliberately gated on observed skew).

---

## The lifecycle-evidence program

The memory taxonomy (`decision | rationale | progress`) is load-bearing
— dedup keys, contradiction filtering, injection priority all key on
it. Real extraction batches showed force-fits: standing constraints
filed as `progress`, conventions as `decision`. The interesting
discovery: the misfits differ not by *category* but by **lifecycle
dynamics** — conditional expiry ("until the merge happens") vs
amendable-persistent (conventions) vs fast-decay (status updates).

Rather than redesign the schema from theory, memorize instruments
first:

- **Extraction-side evidence**: the extractor attaches observe-only
  fields — `obsoleteWhen` (free-form expiry condition), `kindMisfit` +
  reason, `supersedesNote`, free-form `tags` — persisted but read by no
  consumer.
- **Behavioral evidence**: per-memory telemetry — injection counts
  (startup and mid-session), superseded/contradicted events,
  age-at-invalidation — recording how memories actually *lived*.
- `memorize consolidate --report` dumps both distributions; after a few
  weeks of dogfooding the data decides whether `kind` becomes a set of
  named lifecycle policies.

This observe-first loop (instrument → dogfood → decide) is how memorize
evolves its own schema.

---

## Adoption and the ground rule

Two composing mechanisms keep the shared brain authoritative:

- **`memorize memory import`** absorbs context that predates memorize:
  the agent (not memorize) reads its own harness memory and user-named
  doc folders, distills them into extractor-shaped items honoring the
  per-self/shared split, and pipes them in. Provenance-tagged,
  idempotent, contradiction-checked. Memorize never reads outside the
  project tree.
- **The ground rule** is planted at install time as a marker-managed
  block in `CLAUDE.md` / `AGENTS.md` (and echoed as one line in every
  startup injection): project state lives in memorize; the agent's own
  memory keeps only per-self content. Uninstall removes exactly the
  block.

---

## Safety and trust

- **Prompt-injection containment**: all replayed content (observations,
  memories, handoffs — anything once authored by a tool or
  contributor) is wrapped in `<user_data>` sentinels with a trusted
  preamble instructing the agent to treat it as data, never as
  instructions. Sentinel-escaping prevents wrapped content from
  breaking out.
- **Hook trust**: codex silently skips externally-written hooks until
  approved once interactively; `memorize doctor` infers this gap from
  session evidence (hooks registered + other agents recorded sessions +
  codex never did) instead of letting the integration die silently.
- **Local-first**: everything lives under `~/.memorize` (overridable).
  No telemetry leaves the machine; sync targets are yours.

---

## Storage layout

```
<MEMORIZE_ROOT>/projects/<projectId>/
├── memorize.db        # SQLite: events (append-only) + projections +
│                      #   FTS5 index + embeddings + meta (watermarks)
├── locks/             # cross-process file locks
├── sync/              # remote sync state
└── topics/            # imported rules as readable .md topics
```

Versioned migrations (`PRAGMA user_version`) upgrade the schema in
place; projections are derived and rebuilt by replay, so a wiped cache
is never data loss. The event log is the unit of backup, export, and
cross-machine cloning.
