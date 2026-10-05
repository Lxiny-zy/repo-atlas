# repo-atlas

**Offline architecture maps backed by source evidence and explicit review.**

[![CI](https://github.com/Lxiny-zy/repo-atlas/actions/workflows/ci.yml/badge.svg)](https://github.com/Lxiny-zy/repo-atlas/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[中文](README.md) · [Documentation](docs/README.md) · [CLI reference](docs/cli.md) · [Manifest contract](references/manifest-format.md) · [Contributing](CONTRIBUTING.md)

![Chinese order-journey report: purpose and business flows before implementation details](examples/order-journey/desktop.png)

repo-atlas turns a human-authored or AI-assisted `atlas.json` into a self-contained HTML report. Readers can trace modules, business chains, data objects and findings back to source excerpts. Snapshots, incremental diffs and explicit reviews keep that knowledge maintainable after the code changes.

Use it to understand an unfamiliar repository, trace a feature end to end, or deliver architecture documentation that remains reviewable. **It does not automatically understand business semantics or prove runtime behavior from static relationships.**

## Try it in five minutes

Requires Node.js 18+. Prefer an actively maintained Node.js LTS release. Building reports has no runtime npm dependencies; no `npm install` is needed.

```sh
git clone https://github.com/Lxiny-zy/repo-atlas.git
cd repo-atlas
node scripts/validate.mjs examples/order-journey/atlas.json
node scripts/build.mjs examples/order-journey/atlas.json
```

Open `examples/order-journey/report.html` directly. This Chinese-language demonstration explains placing and cancelling an order, with source details available on demand. Its synthetic source explicitly leaves payment, shipping and persistent storage outside the demonstrated behavior. To rebuild an existing output, add `--replace`.

The [reader-experience guide](references/reader-experience.md) describes how to write business-oriented titles, stages and conclusions while keeping function names and file paths in evidence details.

For the complete multi-chain example:

```sh
node scripts/build.mjs tests/fixtures/multi-chain/atlas.json
```

Open `tests/fixtures/multi-chain/report.html`. Mermaid, icons, styles and interactions are embedded: no CDN or local server is required.

## Capabilities

| Reader need | Support |
|---|---|
| Understand module relationships | Overview, module details, authored upstream/downstream neighbors and stable links |
| Follow business flows | Triggers, evidence-backed stages, outcomes, recovery and unresolved questions |
| Check the evidence | Source anchors, numbered excerpts, search, ambiguous and stale evidence states |
| Understand knowledge gaps | Confirmed/inferred/unverified conclusions; separate coverage and review status |
| Refresh previous work | File hashes, Git baselines, affected entities, unowned changes and bounded context |
| Deliver reviewed versions | Explicit review tasks, new version directories, integrity receipts and semantic comparison |

Coverage counts applicable stages only. Relationship navigation describes authored knowledge, not runtime call paths, blast radius or merge safety.

## Map your own project

1. Read the [manifest contract](references/manifest-format.md) and start from [atlas.example.json](schemas/atlas.example.json).
2. Set `workspace` relative to the manifest's directory. Source paths, file groups and `output` are relative to that workspace.
3. Select real source evidence, explain the scope and record uncertainties.
4. Validate, then build.

```sh
node /path/to/repo-atlas/scripts/validate.mjs docs/architecture/atlas.json
node /path/to/repo-atlas/scripts/build.mjs docs/architecture/atlas.json
```

For `your-project/docs/architecture/atlas.json`, use `workspace: "../.."` and, for example, `output: "docs/architecture/report.html"`. Replace the executable paths on Windows and quote paths containing spaces.

VS Code associations are included. External manifests may point `$schema` at the local [JSON Schema](schemas/atlas.schema.json). CLI validation always uses bundled rules and never fetches that address.

### Agent skill

The repository includes [SKILL.md](SKILL.md), display metadata and scripts. Place the complete directory in a skill location supported by your host, following that host's installation instructions. The Node CLI also works independently.

Example request:

> Analyze order creation from POST /orders through authorization, validation, persistence, inventory reservation and event consumption. Cover success, failures, retries, idempotency and compensation. Include only necessary shared modules, configuration and data models. Deliver business flows, source evidence and unresolved questions.

## Maintain a report after code changes

After reviewing the initial source and report, establish a baseline:

```sh
node scripts/snapshot.mjs path/to/atlas.json
```

After source changes:

```sh
node scripts/delta.mjs path/to/atlas.json
node scripts/context.mjs path/to/atlas.json --changed-only
node scripts/refresh.mjs path/to/atlas.json
```

State defaults to `.repo-atlas/` **inside the manifest's workspace**. The candidate `atlas.next.json` is written beside the input manifest. Context is bounded to 256 KiB by default, with explicit truncation and omission metadata. Evidence files are always rehashed; unchanged non-evidence files may reuse metadata-based hash caches.

Inspect affected source, update the candidate and fix evidence before preparing a review:

```sh
node scripts/review.mjs path/to/atlas.next.json
```

After actually reviewing the tasks, fill in `reviewer`, timezone-qualified `reviewedAt`, and every task's `decision` and `note` in `.repo-atlas/review.json`. Acceptance requires explicit approval of every item:

```sh
node scripts/accept.mjs path/to/atlas.next.json --review .repo-atlas/review.json
```

The new version directory contains `atlas.json`, `snapshot.json`, `report.html`, `review.json` and `delivery.json`. Existing manifests, baselines and versions remain protected. Continue with the accepted manifest and explicitly select its snapshot using `--from`; see the [CLI reference](docs/cli.md).

Missing or ambiguous evidence blocks acceptance. `build.mjs --review` creates a clearly labeled review preview. Candidate, source or baseline drift invalidates previous review bindings.

### Check and compare deliveries

```sh
node scripts/check-delivery.mjs .repo-atlas/accepted/VERSION
node scripts/compare.mjs old/atlas.json new/atlas.json --json
node scripts/compare.mjs old/atlas.json new/atlas.json --output changes.json
```

Comparison operates on authored semantic entities without requiring the source workspace. File output must stay within the current working directory. Existing results require `--replace`; both inputs remain protected even with that flag. Delivery receipts verify bound file integrity; they do not authenticate reviewers or provide digital signatures.

## Verification

```sh
npm run check
npm test
node scripts/benchmark.mjs --scales 1000,10000
```

`check` verifies first-party JavaScript syntax and local file links in maintained documentation. `test` discovers regression tests automatically and runs the end-to-end fixture. CI is configured for Windows/Linux × Node 18/22/24 and Chromium/Firefox/WebKit checks of normal, review-preview and accepted reports.

Optional browser verification requires separately installed Playwright and matching browsers:

```sh
node scripts/verify.mjs tests/fixtures/multi-chain/report.html --playwright /path/to/playwright/index.mjs --browser chromium
```

The verifier never installs packages or browsers. WebKit's offline-emulation timing difference is recorded in results. Engine checks do not validate real Safari/iPhone devices. See [CONTRIBUTING.md](CONTRIBUTING.md) for a reproducible development setup and richer benchmark scenarios.

## Boundaries and compatibility

- Structural validation does not establish complete business coverage. Reflection, dynamic dispatch, generated code and production configuration require additional evidence.
- `redact` performs literal masking, not automatic secret detection. Inspect manifests and excerpts before sharing.
- Snapshot v2 retains sanitized historical excerpts and per-repository baselines. Upgrading from v1 or relocating a workspace requires source review and a new baseline.
- Reports contain selected source snippets. Distribute them under the same access constraints as the source itself.
- See [package.json](package.json) for the current package version and [CHANGELOG.md](CHANGELOG.md) for unreleased changes.

## Project resources

- [Architecture and extension boundaries](docs/architecture.md)
- [Repository maintenance](docs/maintaining.md) / [Code of conduct](CODE_OF_CONDUCT.md)
- [Analysis guide](references/analysis-guide.md) / [Reusable prompts](references/可复制提示词.md)
- [Contributing](CONTRIBUTING.md) / [Security reporting](SECURITY.md)
- [MIT license](LICENSE) / [Third-party notices](THIRD-PARTY-NOTICES.md)

Use [GitHub Issues](https://github.com/Lxiny-zy/repo-atlas/issues) for bugs and suggestions. Include a small synthetic reproduction, expected/actual behavior and environment details, without private source or sensitive report excerpts.
