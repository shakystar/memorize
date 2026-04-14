# Contributing to Memorize

Thanks for your interest in Memorize. This project is in a structured prototype phase, so contributions are welcome but expect rapid iteration on design and APIs.

## Quick start

```bash
pnpm install
pnpm dev -- project show   # sanity check the CLI
pnpm qa:quick              # typecheck + lint + unit + smoke
```

Before opening a PR, please run:

```bash
pnpm qa:full
```

## Development conventions

- Follow the existing module boundaries in `src/` (`adapters`, `domain`, `projections`, `services`, `workflows`, `storage`).
- Keep changes scoped; prefer small, reviewable PRs.
- Add or update tests under `tests/unit`, `tests/integration`, or `tests/golden` as appropriate.

## License and relicensing

Memorize is currently released under the [MIT License](./LICENSE).

By submitting a contribution (pull request, patch, issue with code, or any other form) to this repository, you agree that:

1. You have the right to submit the contribution under the MIT License.
2. Your contribution is licensed to the project and its users under the MIT License.
3. You grant the project maintainer (shakystar) the right to **relicense the project, including your contribution, under a different license in the future** (for example, a source-available license such as FSL-1.1-MIT or BUSL-1.1). This relicensing right applies only to future releases; any release already published under MIT remains available under MIT.

If you do not agree to these terms, please do not submit contributions.

## Reporting issues

Use GitHub Issues on the [memorize-client repository](https://github.com/shakystar/memorize-client/issues). Include reproduction steps, expected vs actual behavior, and the output of `pnpm dev -- project show` when relevant.
