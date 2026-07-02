# Contributing to Memorize

Thanks for your interest. Issues, discussions, and PRs are all welcome.
The project iterates fast, so expect design and APIs to move.

## Where things go

- **Bug reports and concrete feature requests** go to
  [Issues](https://github.com/shakystar/memorize/issues).
- **Design debates, open-ended ideas, and questions** go to
  [Discussions](https://github.com/shakystar/memorize/discussions).
  Bigger design directions (memory taxonomy, sync semantics) get
  hashed out there before they become issues.

When in doubt, open a discussion first. It gets promoted to an issue
once it has acceptance criteria.

## Development workflow

```bash
pnpm install
pnpm dev -- project show   # sanity check the CLI from source
pnpm build                 # produce dist/ for the `memorize` bin
pnpm qa:quick              # typecheck + lint + unit + smoke
```

Before opening a PR, please run:

```bash
pnpm qa:full               # + integration + golden (CI runs the tests on 3 OSes)
```

Integration tests isolate state via `MEMORIZE_ROOT` in a temp dir, so
never run them against your real `~/.memorize`.

## Development conventions

- Follow the existing module boundaries in `src/` (`adapters`,
  `domain`, `projections`, `services`, `storage`).
- **The event log is append-only** and projections are derived from it.
  PRs must never mutate or delete past events.
- Architectural complexity is evidence-gated: if you propose a retry
  layer, a clock, or a cache, link the observed problem it solves.
- Keep changes scoped, and prefer small, reviewable PRs.
- New behavior needs tests (`tests/unit`, `tests/integration`,
  `tests/golden`); bug fixes need a regression test.
- Use Conventional-commit style messages (`feat(scope): ...`, `fix(scope): ...`).

## Releasing

Releasing is fully automated with
[release-please](https://github.com/googleapis/release-please). The
version is computed from Conventional Commits, never edited by hand.

**Feature PRs must never touch `package.json` `version` or `CHANGELOG.md`.**
A CI `version-guard` job fails any PR that bumps the version (except the
bot's own `release-please--*` branch). Versioning intent travels in the
commit type: `fix:` is a patch, `feat:` is a minor, and `feat!:` or
`BREAKING CHANGE:` is a major.

How a release happens:

1. Feature PRs merge to `main` as usual. Nobody touches the version.
2. release-please opens and keeps a **Release PR** updated (titled e.g.
   `chore(main): release 2.4.0`) with the computed version and a
   CHANGELOG draft built from the merged commits.
3. To ship, optionally add a narrative preamble to the Release PR (edit
   it last, since the bot regenerates it on new `main` commits), then
   **merge the Release PR**.
4. Merging it tags `vX.Y.Z`, creates the GitHub Release, and triggers the
   `publish` job in `.github/workflows/release.yml`, which publishes
   `@shakystar/memorize` to npm via **OIDC Trusted Publishing** (no
   token, `--provenance` attached).

Release timing stays a deliberate human act (merging the Release PR);
only the mechanics are automated.

**Dev-channel snapshots (`publish-dev`).** For pre-release lines under
active development (e.g. the 3.0.0 milestones), a snapshot can be
published without touching the stable channel: manually dispatch the
Release workflow (`gh workflow run release.yml -f base=3.0.0`). The
`publish-dev` job stamps `<base>-dev.<run_number>` in the runner only —
no commit, tag, CHANGELOG entry, or release-please state — and publishes
to the npm **`dev` dist-tag**, so `npm i @shakystar/memorize` (`latest`)
is unaffected while `npm i @shakystar/memorize@dev` gets the snapshot.
The job lives inside `release.yml` because npm Trusted Publishing binds
the package to that single workflow path.

**CI on the Release PR (optional, `RELEASE_PLEASE_TOKEN`).** A PR opened by
the built-in `GITHUB_TOKEN` does not trigger other workflows, so the Release
PR runs no CI by default. `main` is currently unprotected, so this is benign
— the version/CHANGELOG bump is mechanical and the code it ships already
passed CI on its feature PR. The day `main` gains **required status checks**,
provision a token so the Release PR runs `ci.yml` like any other PR:

1. Create a **fine-grained PAT** scoped to this repo with **Contents:
   read/write** and **Pull requests: read/write** (or use a GitHub App token).
2. Add it as the repository secret **`RELEASE_PLEASE_TOKEN`**.

`release.yml` already prefers that secret and falls back to `GITHUB_TOKEN`
when it is absent, so no workflow change is needed when you add it.

## License and relicensing

Memorize is released under
[AGPL-3.0-or-later](../LICENSE).

By submitting a contribution (pull request, patch, issue with code, or
any other form) to this repository, you agree that:

1. You have the right to submit the contribution under
   AGPL-3.0-or-later.
2. Your contribution is licensed to the project and its users under
   AGPL-3.0-or-later.
3. You grant the project maintainer (shakystar) the right to
   **relicense the project, including your contribution, under a
   different license in the future** (for example, a more permissive
   license, or dual-licensing for commercial use). This relicensing
   right applies only to future releases; any release already published
   under a given license remains available under that license.

If you do not agree to these terms, please do not submit contributions.

## Reporting issues

Use [GitHub Issues](https://github.com/shakystar/memorize/issues).
Include reproduction steps, expected vs actual behavior, and the output
of `memorize doctor --json` when relevant.
