# Changelog

## Unreleased

### Repository maintenance

- Added a current documentation index, example guide, community policy and branch/dependency/release maintenance rules; moved dated reviews into `docs/archive/reviews/`.
- Grouped scheduled dependency updates, pinned GitHub Actions v7 commits, and added a stable required Quality gate without duplicate push/PR runs on feature branches.
- Kept Playwright minor/major upgrades manual while Node 18 compatibility remains supported; Playwright 1.63 requires Node 20.
- Fixed candidate refresh through Windows directory aliases and applied the file-navigation offline workaround to WebKit on all platforms, addressing failures visible on hosted CI.

### Reader experience

- Prioritized purpose, business journeys and useful conclusions before relationship diagrams; added direct reading choices and expandable scope notes.
- Replaced implementation jargon in relationship navigation with plain Chinese, expanded module cards with responsibility summaries, and made module source locations opt-in.
- Improved desktop/mobile reading sizes, flow steps and unresolved-question callouts; conclusions now show business impact where authored.
- Added a complete Chinese order-journey demonstration with source-backed boundaries and an authoring guide that separates business explanation from technical identifiers.
- Added three-browser reader-journey checks for reading order, 320px/390px layouts, unresolved outcomes and evidence disclosure.

### Reliability and contributor workflow

- Fixed semantic comparison dropping metadata-like keys inside arbitrary business JSON, including nested arrays and prototype-like property names.
- Protected compare inputs and link aliases; comparison output now stays within the current working directory, uses atomic writes, and requires `--replace` for an existing result. Scripts relying on unrestricted or implicit replacement must be updated.
- Unified user-command option parsing: boolean flags no longer consume paths; unknown/duplicate options, missing values and extra positionals fail before work; added consistent help and `--` handling.
- Strengthened delivery checks with byte hashing, source-binding validation and canonical link containment.
- Cached inventory filesystem reads within each operation while preserving independent group filters, evidence rehashing and cross-snapshot freshness.
- Expanded synthetic benchmarks with repeated samples, extra evidence, overlapping groups, optional local Git history, median/p95 summaries and explicit measurement limitations.
- Added automatic test discovery, syntax/local-documentation checks, focused correctness regressions, pinned development dependencies and lockfile-based CI installs.
- Isolated synthetic fixture inputs from previously generated reports and browser artifacts, fixing build-then-review CI and repeated local verification.
- Made focus-link browser checks wait for the visible navigation result rather than a previously selected module ID, removing a WebKit timing race without weakening assertions.
- Updated the development-only Ajv validator to 8.20.0, outside the affected range of GHSA-2g4f-4pwh-qvx6.
- Reorganized Chinese/English READMEs, added command and architecture references, contributor setup, issue/PR templates, editor conventions and dependency-update configuration.

- Added an offline JSON Schema, VS Code associations, and shared structural/reference validation before build and incremental operations.
- Added read-only batch manifest/evidence diagnostics with JSON Pointer locations, review warnings, safe error output, and explicit check scope.
- Preserved relative editor schema links through refresh/accept without changing semantic hashes; corrected chain-stage ID validation to scope IDs by chain.
- Added manifest regressions and an independent Ajv draft 2020-12 compatibility check to CI.
- Added review task generation and explicit candidate acceptance into a new version directory with a strict report build, baseline, and review receipt.
- Bound review decisions to candidate, source, delta, and baseline versions; incomplete or altered reviews and unresolved evidence block acceptance.
- Added review-only reports with unresolved evidence placeholders and accepted-version provenance.
- Added copyable view, chain, stage, and evidence links, stage highlighting, and invalid-link handling.
- Added Firefox and WebKit verification and CI coverage for normal, review-only, and accepted reports; Windows WebKit transport limitations are reported explicitly.
- Added v2 snapshots with sanitized historical excerpts, per-repository Git baselines, stage identities, and explicit v1 migration requirements.
- Unified evidence parsing and redaction, fixed overlapping inventory groups, and bounded file hashing and historical Git reads.
- Added baseline/source drift validation, optional module path ownership, unowned-change review queues, and preserved pending review state.
- Protected input/output collisions and link boundaries, added atomic writes, and corrected candidate output placement and workspace rebasing.
- Bounded context JSON size with explicit omissions; historical diffs now require verified baseline content and a known redaction policy.
- Added catalog/chain pagination, cached search text, and complete incremental review lists.
- Added focused incremental regressions, a reproducible scale benchmark, and Windows/Linux Node and browser CI jobs.
- Prioritized project context, the current flow, and evidence search on their respective report pages.
- Added direct stage evidence, numbered excerpts with anchor highlighting, dialog return navigation, and browser history for views.
- Corrected chain coverage aggregation and propagated stage review flags to chain badges and filters.
- Improved reading typography and added browser regressions for coverage states, dialog navigation, and mobile content order.

## 0.2.0

- Added evidence-backed multi-chain delivery with stage coverage and quality warnings.
- Added local snapshot, delta, refresh, and model-ready context workflows.
- Added offline chain filtering, stage-level evidence links, bilingual documentation, MIT licensing, and regression fixtures.
