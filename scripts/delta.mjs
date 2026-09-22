import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadManifest, parseOptions, createSnapshot, assertOutputInside, writeJson } from './snapshot-lib.mjs';

const options = parseOptions(process.argv.slice(2));
const manifestArg = options._[0];
if (!manifestArg || options.help) {
  console.error('Usage: node delta.mjs <atlas.json> [--from .repo-atlas/snapshot.json] [--output .repo-atlas/delta.json] [--snapshot-output .repo-atlas/current-snapshot.json]');
  process.exit(options.help ? 0 : 2);
}

const bundle = await loadManifest(manifestArg);
const fromPath = assertOutputInside(bundle.workspace, options.from || '.repo-atlas/snapshot.json');
const baseline = JSON.parse(await readFile(fromPath, 'utf8'));
const current = await createSnapshot(bundle, baseline, { allowMissingSources: true });
const oldFiles = baseline.files || {};
const newFiles = current.files || {};

// Pair equal hashes only among path additions/deletions. This keeps a rename
// from being reported twice while avoiding guesses for rename-plus-edit cases.
const added = [];
const deleted = [];
const modified = [];
const allPaths = new Set([...Object.keys(oldFiles), ...Object.keys(newFiles)]);
for (const path of [...allPaths].sort()) {
  const before = oldFiles[path];
  const after = newFiles[path];
  if (!before && after) added.push({ path, oldSha256: null, newSha256: after.sha256 });
  else if (before && !after) deleted.push({ path, oldSha256: before.sha256, newSha256: null });
  else if (before.sha256 !== after.sha256) modified.push({ path, oldSha256: before.sha256, newSha256: after.sha256 });
}

const addedByHash = new Map();
for (const change of added) (addedByHash.get(change.newSha256) || addedByHash.set(change.newSha256, []).get(change.newSha256)).push(change);
const pairedAdded = new Set();
const pairedDeleted = new Set();
const changes = [];
for (const oldChange of deleted) {
  const candidate = (addedByHash.get(oldChange.oldSha256) || []).find(item => !pairedAdded.has(item.path));
  if (!candidate) continue;
  pairedDeleted.add(oldChange.path);
  pairedAdded.add(candidate.path);
  changes.push({
    path: candidate.path,
    status: 'renamed',
    renamedFrom: oldChange.path,
    oldSha256: oldChange.oldSha256,
    newSha256: candidate.newSha256
  });
}
for (const change of added) if (!pairedAdded.has(change.path)) changes.push({ path: change.path, status: 'added', ...change });
for (const change of deleted) if (!pairedDeleted.has(change.path)) changes.push({ path: change.path, status: 'deleted', ...change });
for (const change of modified) changes.push({ path: change.path, status: 'modified', ...change });
changes.sort((left, right) => left.path.localeCompare(right.path) || left.status.localeCompare(right.status));

for (const change of changes) {
  const paths = [change.path, change.renamedFrom].filter(Boolean);
  change.impact = [...new Set(paths.flatMap(path => [
    ...(baseline.impactIndex?.[path] || []),
    ...(current.impactIndex?.[path] || [])
  ]))].sort();
}

const baselineEvidence = baseline.evidence || {};
const currentEvidence = current.evidence || {};
const staleEvidence = [];
const addStale = (key, oldEvidence, now, reason) => staleEvidence.push({
  key,
  entity: `${now?.entityType || oldEvidence?.entityType}:${now?.entityId || oldEvidence?.entityId}`,
  path: now?.path || oldEvidence?.path,
  reason
});
for (const [key, oldEvidence] of Object.entries(baselineEvidence)) {
  const now = currentEvidence[key];
  let reason = null;
  if (!now) reason = 'evidence was removed from manifest';
  else if (!now.resolved) reason = now.staleReason || 'source anchor is missing or ambiguous';
  else if (now.fileSha256 !== oldEvidence.fileSha256) reason = 'source file changed';
  else if (now.excerptSha256 !== oldEvidence.excerptSha256) reason = 'source excerpt changed';
  else if (now.path !== oldEvidence.path || now.match !== oldEvidence.match || now.occurrence !== oldEvidence.occurrence || now.length !== oldEvidence.length || (oldEvidence.redactSha256 != null && now.redactSha256 !== oldEvidence.redactSha256)) reason = 'evidence definition changed';
  if (reason) addStale(key, oldEvidence, now, reason);
}
for (const [key, now] of Object.entries(currentEvidence)) {
  if (!baselineEvidence[key] && !now.resolved) addStale(key, null, now, now.staleReason || 'source anchor is missing or ambiguous');
}

const reusedEvidence = Object.entries(currentEvidence).filter(([key, now]) => {
  const old = baselineEvidence[key];
  return Boolean(old && now.resolved && old.fileSha256 === now.fileSha256 && old.excerptSha256 === now.excerptSha256 && old.path === now.path && old.match === now.match && old.occurrence === now.occurrence && old.length === now.length && (old.redactSha256 == null || old.redactSha256 === now.redactSha256));
}).length;
const recomputedEvidence = Object.values(currentEvidence).filter(item => item.resolved).length - reusedEvidence;
const manifestChanged = baseline.analysisManifestSha256 != null
  ? baseline.analysisManifestSha256 !== current.analysisManifestSha256
  : baseline.manifestSha256 !== current.manifestSha256;
const impacted = [...new Set([
  ...changes.flatMap(change => change.impact),
  ...staleEvidence.map(item => item.entity),
  ...(manifestChanged ? Object.values(current.impactIndex || {}).flat() : [])
])].sort();
const modifiedCount = changes.filter(change => change.status === 'modified').length;
const previousFileCount = Object.keys(oldFiles).length;
const changedFileRatio = previousFileCount ? changes.length / previousFileCount : changes.length ? 1 : 0;
const broadChange = changes.length >= 20 || (previousFileCount >= 10 && changedFileRatio > 0.2);
const infrastructureChanges = changes.filter(change => /(^|\/)(package(?:-lock)?\.json|pnpm-lock\.ya?ml|yarn\.lock|Cargo\.lock|go\.mod|pyproject\.toml|pom\.xml|.*\.sql|.*\.ya?ml|docker-compose|Dockerfile)/i.test(change.path));
const fullReanalysisReasons = [
  ...(manifestChanged ? ['analysis manifest changed'] : []),
  ...(broadChange ? ['change volume exceeds incremental threshold'] : []),
  ...(infrastructureChanges.length ? [`shared infrastructure changed (${infrastructureChanges.map(change => change.path).join(', ')})`] : [])
];
const fullReanalysisRecommended = fullReanalysisReasons.length > 0;
const delta = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  from: { path: options.from || '.repo-atlas/snapshot.json', generatedAt: baseline.generatedAt, git: baseline.git || null },
  to: { git: current.git, manifestSha256: current.manifestSha256, analysisManifestSha256: current.analysisManifestSha256 },
  changes,
  staleEvidence,
  impacted,
  summary: {
    added: changes.filter(change => change.status === 'added').length,
    modified: modifiedCount,
    deleted: changes.filter(change => change.status === 'deleted').length,
    renamed: changes.filter(change => change.status === 'renamed').length,
    changedFiles: changes.length,
    changedFileRatio: Number(changedFileRatio.toFixed(4)),
    reusedEvidence,
    recomputedEvidence,
    staleEvidence: staleEvidence.length,
    impactedEntities: impacted.length,
    manifestChanged,
    fullReanalysisRecommended,
    fullReanalysisReasons
  }
};

const snapshotOutput = options['snapshot-output'];
if (snapshotOutput) {
  const snapshotPath = assertOutputInside(bundle.workspace, snapshotOutput);
  if (snapshotPath === fromPath) throw new Error('snapshot-output must differ from --from; baseline snapshots are never overwritten by delta.mjs');
  await mkdir(dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, writeJson(current), { encoding: 'utf8', flag: 'w' });
  delta.currentSnapshotPath = snapshotOutput;
}
const output = assertOutputInside(bundle.workspace, options.output || '.repo-atlas/delta.json');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, writeJson(delta), { encoding: 'utf8', flag: 'w' });
console.log(JSON.stringify({ output, ...delta.summary, commit: current.git.shortCommit }, null, 2));
