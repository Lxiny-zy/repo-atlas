# Security Policy

`repo-atlas` reads local source files selected by an explicit manifest and writes an offline report. It is not a security scanner, secret detector, or production connectivity tool.

Do not include credentials, personal data, production samples, or unrestricted environment files in `atlas.json` evidence. Review generated HTML before publishing it.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/Lxiny-zy/repo-atlas/security/advisories/new) when it is enabled. If the private-reporting form is unavailable, open a minimal issue asking the maintainers for a private contact; omit exploit details and sensitive data until a private channel is established. This repository does not publish a separate security email or guarantee a response SLA.

Include the affected commit/version, OS and Node versions, exact command, expected and actual behavior, and a small synthetic reproduction. Relevant boundaries include source/path containment, input overwrite protection, report rendering, redaction and review/delivery bindings.

## Trust model

Manifests and selected source may contain sensitive data. Literal `redact` rules do not discover secrets automatically. Inspect both manifests and HTML before distribution.

Review receipts record local decisions and artifact integrity. They are not signed identities, and an actor able to rewrite all inputs and receipts can replace the whole declaration. Delivery checks do not substitute for source review or access control.

Use an actively maintained Node.js release for security updates even where older versions remain covered by compatibility tests. Security fixes should be verified against the latest source; there is no published long-term maintenance commitment for older releases.
