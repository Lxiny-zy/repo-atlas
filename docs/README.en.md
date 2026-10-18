# repo-atlas

**Understand a project through its architecture, business processes, data flows and data structures.**

[![CI](https://github.com/Lxiny-zy/repo-atlas/actions/workflows/ci.yml/badge.svg)](https://github.com/Lxiny-zy/repo-atlas/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[中文](../README.md) · [CLI reference](cli.md) · [Manifest contract](manifest-format.md) · [Contributing](../.github/CONTRIBUTING.md)

![Chinese order-journey report: explore module responsibilities, data flows and data objects](../examples/order-journey/desktop.png)

repo-atlas turns a human-authored or AI-assisted `atlas.json` into a self-contained HTML report. Readers explore architecture, data flows, business processes and ER diagrams by selecting modules and data objects. Source hyperlinks and structured evidence support AI analysis, verification and incremental maintenance.

Use it to understand an unfamiliar repository, trace a feature end to end, or deliver architecture documentation that remains reviewable. **It does not automatically understand business semantics or prove runtime behavior from static relationships.**

## Try it in five minutes

Requires Node.js 18+. Prefer an actively maintained Node.js LTS release. Building reports has no runtime npm dependencies; no `npm install` is needed.

```sh
git clone https://github.com/Lxiny-zy/repo-atlas.git
cd repo-atlas
node scripts/validate.mjs examples/order-journey/atlas.json
node scripts/build.mjs examples/order-journey/atlas.json
```

Open `examples/order-journey/report.html` directly. Start with module responsibilities and data flows, follow ordering and cancellation through their conditions and outcomes, then inspect states and data structures. Module connections show data delivery only; selecting a module reveals its incoming and outgoing data and related objects. Source code is available through links and optional excerpts. The synthetic example identifies its storage as in-memory objects. To rebuild an existing output, add `--replace`.

Markers move along data-flow arrows with play/pause controls. Selecting a module limits motion to its related flows. Motion illustrates declared direction, not live activity, transfer speed or execution order. Reduced-motion preferences default to a static view; SVG exports and printing retain static arrows.

The [reader-experience guide](analysis-guide.md#面向读者的表达) describes how to write business-oriented titles, stages and conclusions while keeping function names and file paths in evidence details.

Rebuild and check examples after updating the tool:

```sh
npm run examples:build
npm run examples:check
npm run examples:verify -- --browser chromium
```

`examples:check` reads current generator, manifest and source inventory fingerprints and fails for stale or missing reports. `examples:verify` checks freshness before browser validation and never rebuilds implicitly. The footer and About dialog show generator identity, manifest identity and generation time. CI publishes rebuildable synthetic examples with browser artifacts.

For the complete multi-chain example:

```sh
node scripts/build.mjs tests/fixtures/multi-chain/atlas.json
```

Open `tests/fixtures/multi-chain/report.html`. Mermaid, icons, styles and interactions are embedded: no CDN or local server is required.

## Capabilities

| Reader need | Support |
|---|---|
| Understand architecture | Module responsibilities and boundaries, with related data flows highlighted on selection |
| Trace data | Moving markers from sender to recipient, playback controls, module focus and payload descriptions |
| Follow business flows | Branching flowcharts, sequence diagrams, state diagrams and linked stages |
| Inspect data structures | Interactive ER objects with fields, keys and explicit logical or database references |
| Trace source evidence | Real source hyperlinks, optional excerpts and structured evidence for AI |
| Check the evidence | Source anchors, numbered excerpts, search, ambiguous and stale evidence states |
| Understand knowledge gaps | Confirmed/inferred/unverified conclusions; separate coverage and review status |
| Refresh previous work | File hashes, Git baselines, affected entities, unowned changes and bounded context |
| Deliver reviewed versions | Explicit review tasks, new version directories, integrity receipts and semantic comparison |

Coverage counts applicable stages only. Relationship navigation describes authored knowledge, not runtime call paths, blast radius or merge safety.

## Map your own project

1. Read the [manifest contract](manifest-format.md) and start from [atlas.example.json](../schemas/atlas.example.json).
2. Set `workspace` relative to the manifest's directory. Source paths, file groups and `output` are relative to that workspace.
3. Select real source evidence, explain the scope and record uncertainties.
4. Validate, then build.

```sh
node /path/to/repo-atlas/scripts/validate.mjs docs/architecture/atlas.json
node /path/to/repo-atlas/scripts/build.mjs docs/architecture/atlas.json
```

For `your-project/docs/architecture/atlas.json`, use `workspace: "../.."` and, for example, `output: "docs/architecture/report.html"`. Replace the executable paths on Windows and quote paths containing spaces.

Manifests may point `$schema` at the local [JSON Schema](../schemas/atlas.schema.json). CLI validation always uses bundled rules and never fetches that address.

### Agent skill

The repository includes [SKILL.md](../SKILL.md), display metadata and scripts. Place the complete directory in a skill location supported by your host, following that host's installation instructions. The Node CLI also works independently.

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

Structural report warnings create `quality-warning` review tasks. Repair them and prepare a new review, or explicitly approve each with a reason. Unresolved evidence still blocks acceptance.

```sh
node scripts/accept.mjs path/to/atlas.next.json --review .repo-atlas/review.json
```

The new version directory contains `atlas.json`, `snapshot.json`, `report.html`, `review.json` and `delivery.json`. Existing manifests, baselines and versions remain protected. Continue with the accepted manifest and explicitly select its snapshot using `--from`; see the [CLI reference](cli.md).

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

The verifier never installs packages or browsers. WebKit's offline-emulation timing difference is recorded in results. Engine checks do not validate real Safari/iPhone devices. See [CONTRIBUTING.md](../.github/CONTRIBUTING.md) for a reproducible development setup and richer benchmark scenarios.

## Boundaries and compatibility

- Structural validation does not establish complete business coverage. Reflection, dynamic dispatch, generated code and production configuration require additional evidence.
- `redact` performs literal masking, not automatic secret detection. Inspect manifests and excerpts before sharing.
- Snapshot v2 retains sanitized historical excerpts and per-repository baselines. Upgrading from v1 or relocating a workspace requires source review and a new baseline.
- Reports contain selected source snippets. Distribute them under the same access constraints as the source itself.
- See [package.json](../package.json) for the current package version and [CHANGELOG.md](CHANGELOG.md) for unreleased changes.

## Project resources

- [Architecture and extension boundaries](architecture.md)
- [Analysis and writing guide](analysis-guide.md) / [Code of conduct](../.github/CODE_OF_CONDUCT.md)
- [Contributing](../.github/CONTRIBUTING.md) / [Security reporting](../.github/SECURITY.md)
- [MIT license](../LICENSE) / [Third-party notices](THIRD-PARTY-NOTICES.md)

Use [GitHub Issues](https://github.com/Lxiny-zy/repo-atlas/issues) for bugs and suggestions. Include a small synthetic reproduction, expected/actual behavior and environment details, without private source or sensitive report excerpts.
