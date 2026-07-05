# Security Policy

## Supported versions

Security fixes land on the latest published release. Older releases are not backported.

| Version | Supported |
| --- | --- |
| latest `3.x` | Yes |
| older | No |

## Reporting a vulnerability

**Please do not open public GitHub issues for security problems.**

Found something in Memorize? Report it privately through one of these channels:

1. **GitHub Security Advisories** (preferred): [Report a vulnerability](https://github.com/shakystar/memorize/security/advisories/new).
2. **Email**: open an issue asking for a private contact, or reach the maintainer at the address listed on the GitHub profile [shakystar](https://github.com/shakystar).

Please include:

- A clear description of the issue and its impact.
- Steps to reproduce, or a minimal proof-of-concept.
- The affected version(s) and platform.
- A suggested mitigation, if you have one.

## Response expectations

- **Acknowledgement:** within 7 days of the initial report.
- **Triage and severity assessment:** within 14 days.
- **Fix or mitigation plan:** communicated within 30 days for high-severity issues. Lower-severity issues may be batched into the next regular release.
- **Coordinated disclosure:** we agree on a disclosure timeline with the reporter before any public announcement. You get credit in the release notes unless you'd rather stay anonymous.

## Scope

In scope:

- The `@shakystar/memorize` CLI and its published artifacts.
- Code under `src/`, CLI launch wrappers, and installation/bootstrap flows.
- Default configuration shipped with the project.

Out of scope:

- Vulnerabilities in upstream dependencies. Report those to the respective projects; we'll bump affected versions once they're fixed upstream.
- Issues that require a compromised local machine or existing shell access to exploit.
- Social engineering, physical attacks, and issues in third-party services (Claude, Codex, npm registry, GitHub) not caused by Memorize code.

Thank you for helping keep Memorize and its users safe.
