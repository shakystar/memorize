# Security Policy

## Supported versions

Memorize is in a structured prototype phase. Only the latest `0.x` release receives security fixes. Once `1.0.0` is published, this policy will be updated with an extended support window.

| Version | Supported |
| --- | --- |
| latest `0.x` | ✅ |
| older `0.x` | ❌ |

## Reporting a vulnerability

**Please do not open public GitHub issues for security problems.**

If you believe you have found a security vulnerability in Memorize, report it privately using one of the following channels:

1. **GitHub Security Advisories** — [Report a vulnerability](https://github.com/shakystar/memorize/security/advisories/new) (preferred)
2. **Email** — open an issue asking for a private contact, or reach the maintainer via the address listed on the GitHub profile [shakystar](https://github.com/shakystar).

When reporting, please include:

- A clear description of the issue and its impact.
- Steps to reproduce, or a minimal proof-of-concept.
- The affected version(s) and platform.
- Any suggested mitigation, if you have one.

## Response expectations

- **Acknowledgement:** within 7 days of the initial report.
- **Triage and severity assessment:** within 14 days.
- **Fix or mitigation plan:** communicated within 30 days for high-severity issues. Lower-severity issues may be batched into the next regular release.
- **Coordinated disclosure:** we will agree on a disclosure timeline with the reporter before any public announcement. Credit will be given in the release notes unless the reporter prefers to remain anonymous.

## Scope

In scope:

- The `@shakystar/memorize` CLI and its published artifacts.
- Code under `src/`, CLI launch wrappers, and installation/bootstrap flows.
- Default configuration shipped with the project.

Out of scope:

- Vulnerabilities in upstream dependencies (please report these to the respective projects; we will update affected versions as they are fixed upstream).
- Issues that require a compromised local machine or existing shell access to exploit.
- Social engineering, physical attacks, or issues in third-party services (Claude, Codex, npm registry, GitHub) not caused by Memorize code.

Thank you for helping keep Memorize and its users safe.
