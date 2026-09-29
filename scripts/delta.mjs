import { readFile } from 'node:fs/promises';
import { loadManifest, parseOptions, createSnapshot, assertOutputInside, writeJson, assertBaselineWorkspace, snapshotHash, protectedSourcePaths } from './snapshot-lib.mjs';
import { planOutput, atomicWrite } from './io-lib.mjs';

const options = parseOptions(process.argv.slice(2));
const manifestArg = options._[0];
if (!manifestArg || options.help) {
  console.error('Usage: node delta.mjs <atlas.json> [--from .repo-atlas/snapshot.json] [--output .repo-atlas/delta.json] [--snapshot-output .repo-atlas/current-snapshot.json]');
  process.exit(options.help ? 0 : 2);
}

const bundle = await loadManifest(manifestArg);
const fromPath = assertOutputInside(bundle.workspace, options.from || '.repo-atlas/snapshot.json');
const baseline = JSON.parse(await readFile(fromPath, 'utf8'));
assertBaselineWorkspace(bundle, baseline);
const current = await createSnapshot(bundle, baseline, { allowMissingSources: true });
const protectedPaths = [...protectedSourcePaths(bundle, { ...baseline.files, ...current.files }), fromPath];
const output = planOutput(bundle.workspace, options.output || '.repo-atlas/delta.json', { protectedPaths });
const snapshotOutput = options['snapshot-output'];
const snapshotPath = snapshotOutput ? planOutput(bundle.workspace, snapshotOutput, { protectedPaths: [...protectedPaths, output] }) : null;
const oldFiles = baseline.files || {};
const newFiles = current.files || {};

// A rename is inferred only when the hash has exactly one added and deleted path.
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
const deletedByHash = new Map();
for (const change of deleted) deletedByHash.set(change.oldSha256, (deletedByHash.get(change.oldSha256) || 0) + 1);
const pairedAdded = new Set();
const pairedDeleted = new Set();
const changes = [];
for (const oldChange of deleted) {
  const candidates = addedByHash.get(oldChange.oldSha256) || [];
  const candidate = candidates.length === 1 && deletedByHash.get(oldChange.oldSha256) === 1 ? candidates[0] : null;
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
  else if (now.definitionSha256 !== oldEvidence.definitionSha256 || now.redactSha256 !== oldEvidence.redactSha256) reason = 'evidence definition changed';
  if (reason) addStale(key, oldEvidence, now, reason);
}
for (const [key, now] of Object.entries(currentEvidence)) {
  if (!baselineEvidence[key]) addStale(key, null, now, now.staleReason || 'new evidence requires review');
}

const reusedEvidence = Object.entries(currentEvidence).filter(([key, now]) => {
  const old = baselineEvidence[key];
  return Boolean(old && now.resolved && old.fileSha256 === now.fileSha256 && old.excerptSha256 === now.excerptSha256 && old.definitionSha256 === now.definitionSha256 && old.redactSha256 === now.redactSha256);
}).length;
const recomputedEvidence = Object.values(currentEvidence).filter(item => item.resolved).length - reusedEvidence;
const manifestChanged = baseline.analysisManifestSha256 != null
  ? baseline.analysisManifestSha256 !== current.analysisManifestSha256
  : baseline.manifestSha256 !== current.manifestSha256;
const impacted = [...new Set([
  ...changes.flatMap(change => change.impact),
  ...staleEvidence.map(item => item.entity),
  ...(manifestChanged ? Object.keys(current.summaryIndex || {}) : []),
  ...staleEvidence.filter(item => item.entity.startsWith('chain-stage:')).map(item => `chain:${item.entity.slice('chain-stage:'.length).split('/')[0]}`)
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
const unmappedChanges = changes.filter(change => !change.impact.length).map(change => ({ path: change.path, status: change.status, reason: 'No evidence or module ownership maps this change' }));
const delta = {
  schemaVersion: 2,
  workspaceSha256: current.workspaceSha256,
  generatedAt: new Date().toISOString(),
  from: { path: options.from || '.repo-atlas/snapshot.json', snapshotSha256: snapshotHash(baseline), generatedAt: baseline.generatedAt, git: baseline.git || null },
  to: { git: current.git, manifestSha256: current.manifestSha256, analysisManifestSha256: current.analysisManifestSha256, inventorySha256: current.inventorySha256 },
  changes,
  unmappedChanges,
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
    unmappedChanges: unmappedChanges.length,
    reviewRequired: Boolean(impacted.length || unmappedChanges.length || fullReanalysisRecommended),
    manifestChanged,
    fullReanalysisRecommended,
    fullReanalysisReasons
  }
};

if (snapshotPath) {
  await atomicWrite(bundle.workspace, snapshotPath, writeJson(current), { protectedPaths: [...protectedPaths, output] });
  delta.currentSnapshotPath = snapshotOutput;
}
await atomicWrite(bundle.workspace, output, writeJson(delta), { protectedPaths });
console.log(JSON.stringify({ output, ...delta.summary, commit: current.git.shortCommit }, null, 2));
