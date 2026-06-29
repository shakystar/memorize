# Harness conformance (Docker)

Repeatable, containerised verification that memorize's integration still works
against the **real** agent-harness CLIs. This replaces manual dogfooding for the
parts that can be automated and is the backbone of harness-compatibility
maintenance: when an upstream harness changes its config schema, paths, or
plugin API, a scheduled run here turns that silent drift into a red check.

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

- Tier A, A', **A''** run on every PR touching harness code (model-free,
  deterministic). A'' feeds the MAPPED tool payloads the plugin emits
  (`Write`/`Edit`/`shell`) to the real `memorize hook` and asserts capture.
- Tier B (live, model) runs on **schedule + manual dispatch only** — cost/flake
  control. Auto-enables when the `ANTHROPIC_API_KEY` repo secret exists.

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
