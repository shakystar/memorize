# Harness-conformance image — repeatable maintenance automation.
#
# Builds memorize from source, installs it globally, and (at run time) installs
# a real agent-harness CLI and verifies memorize's integration against it. This
# is how we catch UPSTREAM HARNESS DRIFT (config schema/paths, plugin load)
# without manual dogfooding.
#
# Build context = repo root:
#   docker build -f docker/conformance/Dockerfile -t memorize-conformance .
# Run (tier A — model-free, deterministic):
#   docker run --rm memorize-conformance opencode
# Run (tier B — live capture; needs a provider key in the image env):
#   docker run --rm -e OPENCODE_CONFORMANCE_LIVE=1 -e <PROVIDER_API_KEY> \
#     memorize-conformance opencode
FROM node:22-bookworm-slim

# better-sqlite3 ships prebuilds for linux x64; keep the toolchain available as
# a fallback so `pnpm install` never fails on a missing native binary.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /memorize
COPY . .
# Build memorize and install it globally so `memorize` is on PATH (install then
# resolves the node-abs hook command form → the planted plugins reach THIS
# build, not the published package).
RUN pnpm install --frozen-lockfile \
  && pnpm build \
  && npm i -g . \
  && memorize --version || true

ENV HOME=/root
WORKDIR /work
ENTRYPOINT ["bash", "/memorize/docker/conformance/run.sh"]
