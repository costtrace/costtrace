# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report vulnerabilities privately through GitHub:
**[Security → Report a vulnerability](https://github.com/costtrace/costtrace/security/advisories/new)**.

Include what you found, how to reproduce it, and the affected version. You can expect an initial
response within 7 days. We'll keep you updated while we work on a fix and credit you in the advisory
unless you prefer otherwise.

## Supported versions

CostTrace is pre-1.0. Security fixes go into the latest published version only.

## Handling billing data

CostTrace reads cloud billing exports, which can reveal account IDs, resource names and spend.

- CostTrace runs locally and sends no data anywhere.
- Never commit real billing exports or cloud credentials to this repository. Use the sample data in
  `examples/sample` for tests and bug reports, or redact account IDs and resource names first.
- Secret scanning with push protection is enabled on this repository.
