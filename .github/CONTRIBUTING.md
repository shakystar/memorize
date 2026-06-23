# Contributing to Memorize

Thanks for your interest! Issues, discussions, and PRs are all welcome.
The project iterates quickly, so expect design and APIs to move.

## Where things go

- **Bug reports / concrete feature requests** →
  [Issues](https://github.com/shakystar/memorize/issues)
- **Design debates, open-ended ideas, questions** →
  [Discussions](https://github.com/shakystar/memorize/discussions) —
  bigger design directions (memory taxonomy, sync semantics) are
  deliberately discussed there before becoming issues.

When in doubt, open a discussion first; it gets promoted to an issue
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

Integration tests isolate state via `MEMORIZE_ROOT` in a temp dir —
never run them against your real `~/.memorize`.

## Development conventions

- Follow the existing module boundaries in `src/` (`adapters`,
  `domain`, `projections`, `services`, `storage`).
- **The event log is append-only** and projections are derived — PRs
  must never mutate or delete past events.
- Architectural complexity is evidence-gated: if you propose a retry
  layer, a clock, or a cache, link the observed problem it solves.
- Keep changes scoped; prefer small, reviewable PRs.
- New behavior needs tests (`tests/unit`, `tests/integration`,
  `tests/golden`); bug fixes need a regression test.
- Conventional-commit style messages (`feat(scope): …`, `fix(scope): …`).

## Releasing

Releasing is fully automated with
[release-please](https://github.com/googleapis/release-please); the
version is computed from Conventional Commits, not edited by hand.

**Feature PRs must never touch `package.json` `version` or `CHANGELOG.md`.**
A CI `version-guard` job fails any PR that bumps the version (except the
bot's own `release-please--*` branch). Versioning intent travels in the
commit type: `fix:` → patch, `feat:` → minor, `feat!:` /
`BREAKING CHANGE:` → major.

How a release happens:

1. Feature PRs merge to `main` as usual — nobody touches the version.
2. release-please opens and keeps a **Release PR** updated (titled e.g.
   `chore(main): release 2.4.0`) with the computed version and a
   CHANGELOG draft built from the merged commits.
3. To ship, optionally add a narrative preamble to the Release PR (edit
   it last — the bot regenerates it on new `main` commits), then **merge
   the Release PR**.
4. Merging it tags `vX.Y.Z`, creates the GitHub Release, and triggers the
   `publish` job in `.github/workflows/release.yml`, which publishes
   `@shakystar/memorize` to npm via **OIDC Trusted Publishing** (no
   token, `--provenance` attached).

Release timing stays a deliberate human act (merging the Release PR);
only the mechanics are automated.

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
