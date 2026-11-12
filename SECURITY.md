# Security Policy

## Supported versions

Only the latest published release is supported. This is a 0.x project; there is no long-term support branch.

## Reporting a vulnerability

**Do not open a public issue with exploit details.**

Use GitHub's private vulnerability reporting:

1. Open the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Include enough to reproduce: FinalCheck version, OS, the exact command or UI path, expected vs actual behavior, and a minimal report excerpt.

If private reporting is unavailable, open a minimal public issue asking for a private channel, without exploit details.

Please redact API keys, real credentials, customer data, and full source archives. A short synthetic repro is enough.

## Scope

FinalCheck is a local audit/acceptance tool. It reads code, and by default does **not** execute the audited project's tests or scripts. Areas worth reporting include:

- path escapes or arbitrary file access in the desktop app or MCP server;
- command execution without an approval boundary;
- secret leakage in reports, logs, diagnostics exports, or the UI;
- audit checks that claim a pass without evidence, or silently hide an uncovered dimension.

Known limitations are documented in `docs/ACCEPTED-RISKS.md` and the README: static heuristics can miss or misreport issues, dynamic testing is limited, and installers are currently unsigned.

## Response

This is a single-maintainer project. Reports are handled on a best-effort basis; there is no SLA or bug bounty. Please allow time for a fix and a coordinated disclosure before publishing details.
