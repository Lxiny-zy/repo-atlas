# Contributing

Thank you for helping make source-backed documentation more reliable. Issues and pull requests may be written in Chinese or English. Explain concrete behavior, keep discussion respectful and use synthetic examples.

## Development setup

Use Node.js 18+; prefer an actively maintained LTS release. Building reports and running the core tests need no npm packages. Development-only Ajv and Playwright versions are pinned in `package.json` and `package-lock.json`.

```sh
npm ci
npm run check
npm test
npm run verify:schema
```

- `check`: first-party JavaScript syntax and inline local file links in maintained documentation; it does not fetch remote links or validate heading fragments.
- `test`: discovers `tests/*.test.mjs` without shell glob dependencies, then runs the end-to-end fixture in `scripts/test.mjs`.
- `verify:schema`: compares the bundled validator against Ajv draft 2020-12 behavior.

Core checks also work without `npm ci`: run `npm run check` and `npm test`. The lockfile controls test tooling, not report runtime dependencies.

## Browser changes

Install matching browsers explicitly, then verify synthetic reports:

```sh
npx playwright install chromium firefox webkit
node scripts/build.mjs tests/fixtures/multi-chain/atlas.json
node scripts/verify.mjs tests/fixtures/multi-chain/report.html --browser chromium
node scripts/prepare-review-fixture.mjs tmp-review-local
node scripts/verify.mjs tmp-review-local/unresolved/report.html --browser chromium
node scripts/verify.mjs tmp-review-local/accepted/.repo-atlas/accepted/fixture/report.html --browser chromium
```

On Linux, browser installation may need `npx playwright install --with-deps`. Repeat all three report modes with `--browser firefox` and `--browser webkit` when changing rendering, navigation or the verifier. Use `--replace` to intentionally rebuild an existing report. Choose a fresh review-fixture directory when repeating preparation.

Inspect desktop/mobile screenshots and actual reader flows as well as assertions. Do not report real Safari/iPhone validation from WebKit engine checks. Browser artifacts go into ignored `*.verification/` directories.

For report presentation changes, also run the business-reader demonstration, then repeat with Firefox and WebKit:

```sh
node scripts/build.mjs examples/order-journey/atlas.json
node scripts/verify-reader.mjs examples/order-journey/report.html --browser chromium
```

Review the homepage and a complete flow without opening code: purpose, inputs, outcomes and unknowns should remain understandable. Follow the [reader-experience guide](references/reader-experience.md). The demonstration screenshot used by the READMEs lives at `examples/order-journey/desktop.png`; update it deliberately when the displayed design changes.

## Performance changes

Use the same Node version, OS and scenario before and after a change:

```sh
node scripts/benchmark.mjs --scales 1000,10000
node scripts/benchmark.mjs --scales 1000 --samples 3 --extra-evidence 100 --groups 4 --git
```

The second scenario adds evidence density, overlapping groups and a local Git baseline. Preserve raw samples and state memory scope, workload and sample count. A synthetic speedup is not a promise about all real repositories; do not add fragile wall-clock thresholds to the unit tests. Browser responsiveness needs separate measurement.

## Implementation conventions

- Follow `.editorconfig`, existing ES modules and two-space indentation. Avoid unrelated formatting changes.
- Prefer shared evidence, path, CLI and review primitives; see [architecture](docs/architecture.md).
- Keep runtime builds dependency-free and the report fully offline. Explain any change to that contract.
- For user-controlled JSON, preserve arbitrary business keys. Do not recursively strip metadata names outside their schema-defined locations.
- For filesystem changes, verify canonical containment and input identities; use atomic writes and explicit replacement policies.
- Scope caches to one operation unless invalidation has its own documented guarantees.
- Tests must verify observable behavior and important failure boundaries. Include regressions for reproduced defects, not assertions that merely repeat implementation steps.

## Pull requests and documentation

Lead with the concrete problem and resulting behavior. Include checks actually run, compatibility effects and any validation gaps. Keep changes reviewable; explain performance/complexity tradeoffs.

User-facing changes belong in `CHANGELOG.md` under Unreleased. Keep [README.md](README.md) and [README.en.md](README.en.md) aligned; detailed path/overwrite behavior belongs in [CLI reference](docs/cli.md). Update [SKILL.md](SKILL.md), schema, examples and [manifest contract](references/manifest-format.md) when relevant.

New manifest fields should remain backward compatible or include a migration path. Snapshot changes must explain whether old baselines can be reused. Do not increment a release version solely because a PR is ready; release preparation is a separate maintainer action.

Do not commit generated snapshots, screenshots, business source, credentials or private report contents. Vendor updates must preserve licenses in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), identify upstream versions and pass offline browser checks.

## Reporting issues

Provide the repo-atlas commit/version, Node and OS versions, exact command and working directory, expected/actual behavior, and a minimal synthetic manifest/source. For sensitive vulnerabilities, follow [SECURITY.md](SECURITY.md).
