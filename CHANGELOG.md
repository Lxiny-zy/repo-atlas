# Changelog

## Unreleased

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
