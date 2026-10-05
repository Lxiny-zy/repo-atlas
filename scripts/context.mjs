import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { assertOutputInside, checkedPath, collectSourceRows, loadManifest, parseOptions, writeJson, validateDelta, protectedSourcePaths, buildSummaryIndex } from './snapshot-lib.mjs';
import { planOutput, atomicWrite } from './io-lib.mjs';
import { sourceReader, hashText, redactionValues, redactionHash, redactText, redactValue } from './evidence-lib.mjs';
import { baselineTexts, textDiff } from './git-lib.mjs';
import { budgetContext } from './context-lib.mjs';

const options = parseOptions(process.argv.slice(2), {"boolean":["changed-only","stale-only"],"value":["from","delta","out","output","previous-manifest","max-bytes"],"usage":"Usage: node scripts/context.mjs <atlas.json> [--from snapshot.json] [--delta delta.json] [--output context.json] [--changed-only] [--stale-only] [--previous-manifest atlas.previous.json] [--max-bytes 262144]"});
const bundle = await loadManifest(options._[0]);
const baselinePath = assertOutputInside(bundle.workspace, options.from || '.repo-atlas/snapshot.json');
const deltaPath = assertOutputInside(bundle.workspace, options.delta || '.repo-atlas/delta.json');
const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
const delta = JSON.parse(await readFile(deltaPath, 'utf8'));
const currentSnapshot = await validateDelta(bundle, baseline, delta);
const previousManifestPath = options['previous-manifest'] ? assertOutputInside(bundle.workspace, options['previous-manifest']) : null;
const previousManifest = previousManifestPath ? JSON.parse((await readFile(previousManifestPath, 'utf8')).replace(/^\uFEFF/, '')) : null;
const protectedPaths = [...protectedSourcePaths(bundle, { ...baseline.files, ...currentSnapshot.files }), baselinePath, deltaPath, ...(previousManifestPath ? [previousManifestPath] : [])];
const output = planOutput(bundle.workspace, options.out || options.output || '.repo-atlas/context.json', { protectedPaths });
const maxBytes = Number(options['max-bytes'] ?? 262144);
if (!Number.isInteger(maxBytes) || maxBytes < 4096 || maxBytes > 16 * 1024 * 1024) throw new Error('--max-bytes must be an integer from 4096 to 16777216');
const sourceRows = collectSourceRows(bundle.manifest);
const currentSecrets = redactionValues(sourceRows);
const previousSecrets = previousManifest ? redactionValues(collectSourceRows(previousManifest)) : [];
const secrets = [...new Set([...currentSecrets, ...previousSecrets])];
const historyPolicyKnown = baseline.redactionPolicySha256 === redactionHash(currentSecrets) || (previousManifest && baseline.redactionPolicySha256 === redactionHash(previousSecrets));
const changedOnly = Boolean(options['changed-only']), staleOnly = Boolean(options['stale-only']);
const changedPaths = new Set((delta.changes || []).flatMap(change => [change.path, change.renamedFrom].filter(Boolean)));
const staleEntities = new Set((delta.staleEvidence || []).map(item => item.entity));
const entityKey = (type, id) => `${type}:${id}`;
const entities = new Map();
const addEntity = (type, row, id = row.id ?? row.name ?? row.prefix) => entities.set(entityKey(type, id), { type, id, row });
for (const row of bundle.manifest.modules || []) addEntity('module', row);
for (const row of bundle.manifest.views || []) addEntity('view', row);
for (const row of bundle.manifest.chains || []) {
  addEntity('chain', row);
  for (const stage of row.stages || []) addEntity('chain-stage', { ...stage, modules: stage.modules || row.modules || [] }, `${row.id}/${stage.id}`);
}
for (const [type, collection, field] of [['table','tables','name'], ['route','routes','prefix'], ['flag','flags','name'], ['finding','findings','id'], ['coverage','coverage','id']]) {
  for (const row of bundle.manifest[collection] || []) addEntity(type, row, row[field]);
}
const selectedKeys = new Set([...(delta.impacted || []), ...staleEntities].filter(key => entities.has(key)));
if (!selectedKeys.size && !changedOnly && !staleOnly) for (const key of entities.keys()) selectedKeys.add(key);
if (staleOnly) for (const key of [...selectedKeys]) if (!staleEntities.has(key)) selectedKeys.delete(key);
const selectedEvidence = new Set([...Object.keys(baseline.evidence), ...Object.keys(currentSnapshot.evidence)].filter(key => {
  const row = currentSnapshot.evidence[key] || baseline.evidence[key];
  return staleOnly ? staleEntities.has(entityKey(row.entityType, row.entityId)) : selectedKeys.has(entityKey(row.entityType, row.entityId)) || (changedOnly && changedPaths.has(row.path));
}));
const historicPaths = [...(delta.changes || []).map(change => change.renamedFrom || change.path), ...[...selectedEvidence].filter(key => baseline.evidence[key]?.storedExcerpt == null).map(key => baseline.evidence[key]?.path).filter(Boolean)];
const oldTexts = historyPolicyKnown ? baselineTexts(bundle.workspace, baseline, historicPaths, { maxBytes: Math.max(1024 * 1024, maxBytes * 8) }) : new Map();
const read = sourceReader(path => checkedPath(bundle.workspace, path));
const readCurrent = async path => {
  const file = await read(path);
  if (file.sha256 !== currentSnapshot.files[path]?.sha256) throw new Error(`Source drift while reading context: ${path}`);
  return file.text;
};
const changedFiles = [];
let currentReadBytes = 0;
for (const change of delta.changes || []) {
  const oldPath = change.renamedFrom || change.path;
  const old = change.oldSha256 == null ? { text: '', reason: null } : historyPolicyKnown ? oldTexts.get(oldPath) : { text: null, reason: 'baseline-redaction-policy-unavailable' };
  const size = currentSnapshot.files[change.path]?.size || 0;
  const readLimited = size > 8 * 1024 * 1024 || currentReadBytes + size > Math.max(1024 * 1024, maxBytes * 8);
  const canDiff = old?.text != null && !readLimited;
  const now = !canDiff || change.newSha256 == null ? '' : await readCurrent(change.path);
  if (canDiff) currentReadBytes += size;
  const safeDiff = canDiff ? redactText(textDiff(old.text, now, change.path), secrets) : null;
  changedFiles.push({ ...change, renamedFrom: change.renamedFrom || null, diff: safeDiff == null ? null : safeDiff.slice(0, 12000), diffTruncated: (safeDiff?.length || 0) > 12000, diffUnavailableReason: old?.text == null ? old?.reason || 'historic-content-unavailable' : readLimited ? 'current-read-budget' : null });
}
const evidence = [];
for (const key of selectedEvidence) {
  const old = baseline.evidence[key], now = currentSnapshot.evidence[key], row = now || old;
  let previous = null, previousUnavailableReason = old ? old.staleReason || 'historic-excerpt-unavailable' : 'not-in-baseline';
  if (old?.resolved && typeof old.storedExcerpt === 'string' && hashText(old.storedExcerpt) === old.storedExcerptSha256) {
    previous = { line: old.line, text: old.storedExcerpt }; previousUnavailableReason = null;
  } else if (old?.resolved && historyPolicyKnown && oldTexts.get(old.path)?.text != null) {
    const raw = oldTexts.get(old.path).text.split(/\r?\n/).slice(old.line - 1, old.line - 1 + old.length).join('\n');
    if (hashText(raw) === old.excerptSha256) { previous = { line: old.line, text: redactText(raw, secrets) }; previousUnavailableReason = null; }
    else previousUnavailableReason = 'historic-excerpt-hash-mismatch';
  }
  evidence.push({ key, entity: entityKey(row.entityType, row.entityId), path: row.path, match: row.match,
    current: now?.resolved ? { line: now.line, text: now.storedExcerpt } : null,
    currentUnavailableReason: now?.resolved ? null : now?.staleReason || 'removed-from-manifest',
    previous, previousUnavailableReason,
    baseline: old ? { line: old.line, resolved: old.resolved, fileSha256: old.fileSha256, excerptSha256: old.excerptSha256 } : null
  });
}
const modules = bundle.manifest.modules || [];
const moduleById = new Map(modules.map(row => [row.id, row]));
const impactedModuleIds = new Set();
for (const key of selectedKeys) {
  const item = entities.get(key);
  if (item?.type === 'module') impactedModuleIds.add(item.id);
  for (const id of item?.row?.modules || []) impactedModuleIds.add(id);
}
for (const chain of bundle.manifest.chains || []) if (selectedKeys.has(`chain:${chain.id}`)) for (const id of chain.modules || []) impactedModuleIds.add(id);
const upstream = modules.filter(row => (row.links || []).some(id => impactedModuleIds.has(id))).map(row => row.id);
const downstream = [...new Set([...impactedModuleIds].flatMap(id => moduleById.get(id)?.links || []))];
const relatedChains = (bundle.manifest.chains || []).filter(chain => (chain.modules || []).some(id => impactedModuleIds.has(id))).map(chain => ({ id: chain.id, title: chain.title, modules: chain.modules || [] }));
const relationships = {
  impactedModules: [...impactedModuleIds].map(id => ({ id, name: moduleById.get(id)?.name || id })),
  upstreamModules: upstream.map(id => ({ id, name: moduleById.get(id)?.name || id })),
  downstreamModules: downstream.map(id => ({ id, name: moduleById.get(id)?.name || id })),
  relatedChains
};

const previousSummaries = previousManifest ? buildSummaryIndex(previousManifest) : baseline.summaryIndex || {};
const selectedEntities = [...selectedKeys].map(key => {
  const { type, id, row } = entities.get(key);
  return { key, type, id, title: row.title || row.name || row.label || row.area || row.prefix || id,
    summary: row.summary || row.description || '', previousSummary: previousSummaries[key]?.summary ?? null,
    status: row.status || null, modules: row.modules || [], stale: staleEntities.has(key),
    sources: sourceRows.filter(source => entityKey(source.entityType, source.entityId) === key).map(source => source.key)
  };
});
const context = redactValue({
  schemaVersion: 2, generatedAt: new Date().toISOString(), purpose: 'incremental-analysis-context',
  baseline: { path: options.from || '.repo-atlas/snapshot.json', generatedAt: baseline.generatedAt, git: baseline.git || null },
  delta: { path: options.delta || '.repo-atlas/delta.json', generatedAt: delta.generatedAt, summary: delta.summary || null },
  filters: { changedOnly, staleOnly, previousManifest: previousManifestPath ? relative(bundle.workspace, previousManifestPath).replaceAll('\\', '/') : null },
  changedFiles, entities: selectedEntities, evidence, relationships, unmappedChanges: delta.unmappedChanges || [],
  omitted: { unchangedEntities: Math.max(0, entities.size - selectedEntities.length), unchangedFiles: Math.max(0, Object.keys(baseline.files).length - changedFiles.length) }
}, secrets);
budgetContext(context, maxBytes);
await atomicWrite(bundle.workspace, output, writeJson(context), { protectedPaths });
console.log(JSON.stringify({ output, changedFiles: context.changedFiles.length, entities: context.entities.length, evidence: context.evidence.length, ...delta.summary }, null, 2));
