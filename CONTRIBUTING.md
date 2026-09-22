# Contributing

## Development

`repo-atlas` has no runtime npm dependencies. Use Node.js 18 or newer.

Run the local regression suite before opening a pull request:

```text
npm test
```

The fixture exercises report generation, snapshots, incremental deltas, chain impact propagation, and the model-ready context bundle. Browser verification is optional and requires an installed Playwright module and browser.

Keep changes focused, preserve the offline report contract, and update `README.md`, `SKILL.md`, or `references/manifest-format.md` when the manifest or command behavior changes. Do not commit generated `.repo-atlas/` snapshots, browser screenshots, or business repository contents.

## Pull requests

Describe the user-facing behavior, the evidence or validation added, and any compatibility impact. New manifest fields should remain backward compatible unless a migration path is documented.
