# Repository maintenance

This repository uses one long-lived branch, `main`. Keep navigation and contribution rules small enough that a new contributor can follow them without knowing the project's development history.

## Files and documentation

- Root documents explain the project, contribution process, license, security and community expectations.
- `docs/` contains current user/developer documentation; its index is [docs/README.md](README.md).
- `references/` contains the manifest and writing contracts used by the skill. Keep these paths stable.
- `examples/` contains synthetic source, reproducible manifests and intentionally selected preview images.
- `docs/archive/` retains dated research and validation records. Do not present archived results as current guarantees.
- Generated reports, runtime snapshots, local dependency installs and browser test artifacts remain ignored.

## Branches and pull requests

Use short-lived `feat/`, `fix/`, `docs/` or `chore/` branches. Open one PR per coherent change. The title describes the resulting behavior; the body explains the problem, validation and compatibility effects.

Merge using squash after the **Quality gate** succeeds and review conversations are resolved. The gate requires all Windows/Linux tests and all browser jobs. Require an up-to-date base before merging. A solo maintainer does not need a second person to approve their own maintenance PR, but should still review the diff and test evidence.

Delete a merged branch after its work is recorded on `main`. For superseded bot branches, first identify the replacement PR or the documented deferral, then close the old PR and remove its branch. Do not delete a contributor's independent work merely to shorten the branch list.

Repository settings should use squash-only merges, automatically delete merged head branches, reject force pushes/deletion of `main`, and require the named quality gate. Keep an administrator recovery path for fixing CI configuration; it is not the normal merge route.

## Dependency updates

Dependabot checks monthly. GitHub Actions updates are grouped into one PR; actions are pinned to immutable commit hashes with readable version comments. npm development-tool minor/patch changes are grouped separately. Keep the number of simultaneous dependency PRs small.

Playwright 1.63 requires Node.js 20 or newer, while the current project still tests Node.js 18 compatibility. Playwright minor/major upgrades are therefore reviewed manually alongside the supported development-runtime policy. Patch updates remain eligible for automation. This is a compatibility decision, not a claim that newer versions are unnecessary.

Do not merge red dependency PRs to clear the queue. If unrelated baseline failures affect every PR, fix the baseline first. Do not leave multiple PRs containing the same maintenance change open after a replacement has merged.

## Releases

The package version and changelog do not by themselves constitute a GitHub release. Before publishing a version:

1. Confirm the intended commit has passed the required CI gate.
2. Reconcile `package.json`, the lockfile and release notes; separate released notes from Unreleased.
3. Document format or runtime compatibility changes and how to upgrade.
4. Create the matching version tag and GitHub release with only deliberate distributable files.

Repository housekeeping does not automatically publish a new version. Avoid creating decorative or empty releases to make the repository appear mature.
