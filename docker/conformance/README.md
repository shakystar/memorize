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

## Status / caveats

- **opencode** descriptor is the first. Tier A is solid. Tier A' (`opencode
  serve` model-free boot) and Tier B field-reads (opencode's plugin payload
  shape, tool names) are **best-effort and need a first real run to tune** — the
  capture plugin's tool-name map / payload reads are documented as live-pending
  in `install-service.ts`.
- Authored where Docker was unavailable; scripts are shell-syntax-checked
  (`bash -n`) but the image build/run should be validated in CI on first use.
