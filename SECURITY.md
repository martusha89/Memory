# Security Policy

## Supported versions

Only the latest release is supported with security fixes.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability involving authentication,
stored memories, or secret exposure. Use GitHub's private vulnerability
reporting for this repository, or contact the maintainer through the address on
their GitHub profile.

Include the affected version, reproduction steps, impact, and any suggested
mitigation. Please avoid accessing anyone else's deployed Memory server or
including real memories or credentials in a report.

## Deployment expectations

- `MEMORY_SECRET` is mandatory; the Worker fails closed when it is absent.
- Bearer headers are the default. Query-string authentication is an explicit
  legacy compatibility option and should remain disabled.
- Cross-origin API access is denied unless an exact origin is configured.
- Back up D1 before applying migrations or enabling consolidation.
