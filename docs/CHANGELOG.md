# Changelog

## Unreleased

- Added reproducible example build/check/verify commands and CI freshness checks; browser artifacts now include generated example HTML with its manifest and synthetic sources.
- Added visible report provenance: package version, generator content hash, raw/semantic manifest hashes, source inventory hash, build mode and generation timestamp. Accepted reports bind the final published manifest rather than staging paths.
- Shared structural quality checks between report warnings and explicit review tasks. Pending quality warnings now block acceptance; approved warnings remain visible in the report.

- Simplified the repository root: consolidated reference documents under docs/, moved community policies into .github/, and removed optional editor-specific configuration. Runtime entry points remain unchanged.

- Removed dated review artifacts and redundant navigation/prompt documents from the working tree; retained history in Git and consolidated current writing/maintenance guidance. Regression tests and report examples remain available.

### Repository maintenance

- Added a community policy and documented branch, dependency and release rules in `CONTRIBUTING.md`.
- Grouped scheduled dependency updates, pinned GitHub Actions v7 commits, and added a stable required Quality gate without duplicate push/PR runs on feature branches.
- Kept Playwright minor/major upgrades manual while Node 18 compatibility remains supported; Playwright 1.63 requires Node 20.
- Fixed candidate refresh through Windows directory aliases and applied the file-navigation offline workaround to WebKit on all platforms, addressing failures visible on hosted CI.

### Reader experience

- Organized reading around project architecture, business processes, data flows and data structures; the neighboring panel explains responsibilities, incoming/outgoing data and related objects.
- Render authored sequence diagrams and optional narrative diagrams; retain stage navigation for manifests without a chart instead of inventing control flow.
- Relation-generated diagrams show data flows only, without dependency/all-relations switches or duplicate overview diagrams. Legacy dependency evidence remains available to snapshot/review/context workflows and is never inferred as data delivery.
- Added interactive ER fields and references, visible business descriptions for transfers, and moving markers along declared data-flow edges with persistent play/pause controls and module-focused motion. Reduced-motion preferences, hidden canvases, print and SVG export are handled explicitly.
- Kept source evidence as hyperlinks and optional excerpts; code explanations remain available in structured data for AI without occupying the primary reader interface.
- Added a responsibility table with a stacked mobile layout; module, stage and object selection remain stable across navigation and viewport changes.
- Expanded the Chinese order example with purchase/cancellation branches and actual state transitions; unconfirmed payment and shipping remain visibly separate.
- Updated authoring guidance and reader checks for diagrams, corresponding code, 960px/390px/320px layouts and unresolved evidence.
- Unified report layout across diagrams and relationship details: constrained sticky readers to the screen, sized short canvases to their content, and kept notes next to their diagrams.
- Added compact diagram/detail tabs, a compact stage selector and earlier navigation collapse; fixed header overlap, stale menu backdrops, hidden SVG selection styles and background changes when opening dialogs.
- Added 65 layout cases per browser across 320–1920px and five visual views, plus direction, payload, ER alias, source-link and history checks.
- Added browser checks against actual SVG geometry for motion direction, pause/resume, parallel-edge bindings, rapid navigation, zoom, mobile pane changes, reduced motion and static exports.

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
