# Harness conformance (Docker)

> **FROZEN — no longer a CI gate.** memorize is now Claude Code-first. The
> non-Claude harness integrations (codex/opencode/gemini/pi/hermes/cursor) are kept
> in-tree and still install/run, but their support is **not guaranteed** and
> they are **not** gated by CI any more — the `harness-conformance.yml` workflow
> was removed. This harness is retained as a **manual** tool: a contributor
> fixing or reviving a frozen harness should run it themselves
> (`docker run --rm memorize-conformance <id>`) and paste the result in the PR.
> Upstream-drift catching is now best-effort/community, not automated.

Repeatable, containerised verification that memorize's integration still works
against the **real** agent-harness CLIs. This replaces manual dogfooding for the
parts that can be automated and was historically the backbone of harness-
compatibility maintenance: when an upstream harness changes its config schema,
paths, or plugin API, a run here turns that silent drift into a visible failure.

## Tiers

| Tier | What | Needs a model? | Determinism |
|---|---|---|---|
| **A — install conformance** | Install the real harness CLI, run `memorize init`, assert the planted artifacts (MCP block, plugin/hook config, ground-rule file). | No | Deterministic |
| **A' — plugin load** | Boot the harness (e.g. `opencode serve`) and check it loads memorize's plugin without a fatal error. | No (best-effort) | Mostly |
| **B — live capture** | Drive the harness with a real prompt and assert memorize captured an observation. | **Yes** (provider key) | Non-deterministic → gated |

Tier A is the hard gate (fails the run). A'/B report and only fail when they
actually execute (B is gated behind an env flag + key).

## Run

From the repo root:

```sh
docker build -f docker/conformance/Dockerfile -t memorize-conformance .

# Tier A + A' (no secrets):
docker run --rm memorize-conformance opencode

# Tier B too (live): pass the flag + your provider key into the container:
docker run --rm -e OPENCODE_CONFORMANCE_LIVE=1 -e OPENAI_API_KEY=… \
  memorize-conformance opencode
```

The image builds memorize from source and `npm i -g .`, so the planted
plugins/hooks invoke THIS build (node-abs command form), not the published npm
package — essential for verifying unreleased harness support.

## Add a harness

Drop a `harnesses/<id>.sh` descriptor defining:

- `install_harness` — install the CLI; return non-zero if unavailable.
- `assert_artifacts` — `ok`/`ko` the files `memorize init` should have written
  for this harness (config path, plugin/hook file, ground-rule file).
- `plugin_load_check` (optional) — boot the harness, detect plugin-load errors.
- `live_capture_check` (optional, gated) — drive a real action, assert capture.

`run.sh` is generic; it sources the descriptor and runs the tiers. The harness
must already exist in `src/harness/registry.ts`.

## Tiers (when each runs)

These tiers no longer run automatically (the CI workflow was removed). Run them
**manually** when touching or reviving a frozen harness:

- Tier A, A', **A''** are model-free and deterministic. A'' feeds the MAPPED tool
  payloads the plugin emits (`Write`/`Edit`/`shell`) to the real `memorize hook`
  and asserts capture.
- Tier B (live, model) needs a provider key; enable per harness with its
  `<ID>_CONFORMANCE_LIVE=1` flag plus the matching key (see Run, above).

## Status — opencode (validated against opencode 1.17.11 in CI)

- Tiers A / A' / A'' / B all green (PASS=9). The live run confirmed opencode's
  real tool names + payload shape: `write`→`Write`, `edit`→`Edit` (both
  captured), `read` correctly ignored. opencode's `tool.execute.after` payload
  is `{ tool, sessionID, callID, args:{ filePath, content|oldString/newString }}`.
- Residual: opencode's `bash` tool name is assumed (not exercised live yet); the
  synthetic tier covers the memorize side for `shell`. The compaction
  (`experimental.session.compacting`) path is not yet exercised end-to-end.
- Tier B currently uses Anthropic haiku; override with `OPENCODE_MODEL` + the
  matching provider key.

## Status — hermes (synthetic-only)

Hermes (`yaml-shell-hooks` family) is validated by the deterministic tiers only.
Its real CLI ships as a curl|bash installer that bundles its own
uv+python+node runtime and needs a Nous provider key even to boot — impractical
on every PR, and we hold no Nous key for a live run. So `install_harness` STUBS
detection (`mkdir ~/.hermes`) unless `HERMES_CONFORMANCE_LIVE=1`, and the
synthetic tier (A'') validates the memorize side end-to-end:

- capture across Hermes tool names (`write_file`/`patch`→write, `terminal`→shell),
- the `pre_llm_call` injection translating our context to Hermes's native
  `{"context": …}` envelope, and
- the once-per-session injection gate (a second `pre_llm_call` for the same
  `session_id` must NOT re-inject — Hermes fires `pre_llm_call` every turn).

Upstream config-schema drift is otherwise tracked manually. Mirrors Gemini's
synthetic-first posture.

## Status — cursor (install-artifact + synthetic only; live tier N/A)

Cursor (`json-hooks-map` family, but PER-PROJECT) ships a **headless CLI agent**
(`cursor-agent`), so it has the full tier ladder like opencode/gemini/pi — not
artifacts-only. (An earlier note here wrongly called it GUI-only; corrected.)

- **Tier A (install artifacts)** — the `.cursor/hooks.json` schema we write (the
  four native events `sessionStart`/`postToolUse`/`preCompact`/`sessionEnd`), the
  `.cursor/mcp.json` MCP block, and the AGENTS.md ground rule.
- **Tier A'' (synthetic, FAITHFUL)** — runs every PR, model-free. Instead of a
  hand-typed `memorize hook` proxy, it extracts and executes the **exact command
  memorize wrote into `.cursor/hooks.json`**, the way Cursor's runtime drives it
  (project-root cwd, documented payload on stdin), asserting capture across cursor
  tool names (`Write` shared with Claude; `Shell` new) and the `sessionStart`
  injection emitting cursor's native `{"additional_context": …}` envelope
  (snake_case, top-level — not `hookSpecificOutput`). Proves the installed artifact
  runs and honors the wire contract end to end.
- **Tier B (live, gated)** — installs the real `cursor-agent`
  (`curl https://cursor.com/install | bash`) and drives `cursor-agent -p` to make
  it perform a file-write tool call, asserting memorize captured it via the
  postToolUse hook. Needs `CURSOR_API_KEY` (headless auth); runs on
  schedule/dispatch. A WRITE prompt is used (cursor-agent has full write access in
  `-p` mode — no approval prompt; a shell prompt would block on y/n).
- **Tier C (upstream-contract drift guard, gated + network-only)** — fetches
  [cursor.com/docs/hooks](https://cursor.com/docs/hooks) and asserts every token
  memorize hardcodes still appears (the four event names, `additional_context`,
  the `Shell`/`Write` tool names, `tool_name`, `.cursor/hooks.json`). Catches an
  upstream rename automatically. Complements tier B: cheap, keyless, and guards
  the IDE/cloud surfaces tier B can't drive.

**Open question tier B settles:** the docs confirm cursor's *cloud* agents fire
`postToolUse` + `preCompact` but NOT `sessionStart`/`sessionEnd` (VM lifecycle).
Whether the *local* `cursor-agent` fires the session-lifecycle hooks is
undocumented, so tier B probes it (it reports whether a `cursor` session was
minted) instead of assuming. The IDE itself is the primary target and is expected
to fire all four; that is verified by hand once and then guarded by tier C.
