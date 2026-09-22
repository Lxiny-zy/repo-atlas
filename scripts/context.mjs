import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  assertOutputInside,
  checkedPath,
  collectSourceRows,
  loadManifest,
  parseOptions,
  repoRelative,
  writeJson
} from './snapshot-lib.mjs';

const options = parseOptions(process.argv.slice(2));
const manifestArg = options._[0];
if (!manifestArg || options.help) {
  console.error('Usage: node context.mjs <atlas.json> [--from .repo-atlas/snapshot.json] [--delta .repo-atlas/delta.json] [--out .repo-atlas/context.json] [--changed-only] [--stale-only] [--previous-manifest atlas.previous.json]');
  process.exit(options.help ? 0 : 2);
}

const bundle = await loadManifest(manifestArg);
const baselinePath = assertOutputInside(bundle.workspace, options.from || '.repo-atlas/snapshot.json');
const deltaPath = assertOutputInside(bundle.workspace, options.delta || '.repo-atlas/delta.json');
const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
const delta = JSON.parse(await readFile(deltaPath, 'utf8'));
const previousManifestPath = options['previous-manifest']
  ? assertOutputInside(bundle.workspace, options['previous-manifest'])
  : null;
const previousManifest = previousManifestPath ? JSON.parse(await readFile(previousManifestPath, 'utf8')) : null;

const changedOnly = Boolean(options['changed-only']);
const staleOnly = Boolean(options['stale-only']);
const changedPaths = new Set((delta.changes || []).flatMap(change => [change.path, change.renamedFrom].filter(Boolean)));
const staleEntities = new Set((delta.staleEvidence || []).map(item => item.entity));
const impacted = new Set(delta.impacted || []);
const entityKey = (type, id) => `${type}:${id}`;
const entities = new Map();
const addEntity = (type, row, id = row.id ?? row.name ?? row.prefix) => {
  const key = entityKey(type, id);
  entities.set(key, { key, type, id, row });
};
for (const row of bundle.manifest.modules || []) addEntity('module', row);
for (const row of bundle.manifest.views || []) addEntity('view', row);
for (const row of bundle.manifest.chains || []) {
  addEntity('chain', row);
  for (const stage of row.stages || []) addEntity('chain', row, `${row.id}/${stage.id}`);
}
for (const [type, rows, idField] of [
  ['table', bundle.manifest.tables, 'name'],
  ['route', bundle.manifest.routes, 'prefix'],
  ['flag', bundle.manifest.flags, 'name'],
  ['finding', bundle.manifest.findings, 'id'],
  ['coverage', bundle.manifest.coverage, 'id']
]) for (const row of rows || []) addEntity(type, row, row[idField]);

const selectedKeys = new Set();
for (const key of impacted) if (entities.has(key)) selectedKeys.add(key);
for (const item of delta.staleEvidence || []) if (entities.has(item.entity)) selectedKeys.add(item.entity);
for (const change of delta.changes || []) for (const key of change.impact || []) if (entities.has(key)) selectedKeys.add(key);
if (!selectedKeys.size && !changedOnly && !staleOnly) for (const key of entities.keys()) selectedKeys.add(key);
if (staleOnly) {
  for (const key of [...selectedKeys]) if (!staleEntities.has(key)) selectedKeys.delete(key);
}

const runGit = args => {
  try {
    return execFileSync('git', ['--no-optional-locks', ...args], {
      cwd: bundle.workspace,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1024 * 1024
    });
  } catch {
    return '';
  }
};
const clip = (value, max = 12000) => value.length > max ? `${value.slice(0, max)}\n... [truncated]` : value;
const diffFor = path => {
  const base = baseline.git?.commit;
  const args = base
    ? ['diff', '--no-ext-diff', '--unified=4', base, '--', path]
    : ['diff', '--no-ext-diff', '--unified=4', '--', path];
  return clip(runGit(args));
};
const oldFileText = new Map();
const currentFileText = new Map();
const readCurrent = async path => {
  if (!currentFileText.has(path)) {
    try { currentFileText.set(path, await readFile(await checkedPath(bundle.workspace, path), 'utf8')); }
    catch { currentFileText.set(path, null); }
  }
  return currentFileText.get(path);
};
const readOld = path => {
  if (!oldFileText.has(path)) {
    const commit = baseline.git?.commit;
    oldFileText.set(path, commit ? runGit(['show', `${commit}:${path}`]) || null : null);
  }
  return oldFileText.get(path);
};
const excerpt = (text, source) => {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  const matches = lines.flatMap((line, index) => line.includes(source.match) ? [index] : []);
  const start = matches[(source.occurrence ?? 1) - 1];
  if (start == null) return null;
  return { line: start + 1, text: lines.slice(start, start + (source.length ?? 8)).join('\n') };
};

const changes = (delta.changes || []).filter(change => !changedOnly || changedPaths.has(change.path) || changedPaths.has(change.renamedFrom));
const changedFiles = await Promise.all(changes.map(async change => ({
  path: change.path,
  status: change.status,
  renamedFrom: change.renamedFrom || null,
  oldSha256: change.oldSha256 || null,
  newSha256: change.newSha256 || null,
  impact: change.impact || [],
  diff: diffFor(change.path)
})));

const sourceRows = collectSourceRows(bundle.manifest);
const selectedSourceRows = sourceRows.filter(source => {
  const key = entityKey(source.entityType, source.entityId);
  if (staleOnly) return staleEntities.has(key);
  if (changedOnly) return changedPaths.has(repoRelative(bundle.workspace, source.path)) || selectedKeys.has(key);
  return selectedKeys.has(key);
});
const evidence = await Promise.all(selectedSourceRows.map(async source => {
  const path = repoRelative(bundle.workspace, source.path);
  const oldRecord = baseline.evidence?.[source.key] || null;
  const current = excerpt(await readCurrent(source.path), source);
  const previous = excerpt(readOld(path), source);
  return {
    key: source.key,
    entity: entityKey(source.entityType, source.entityId),
    path,
    match: source.match,
    current,
    previous,
    baseline: oldRecord ? {
      line: oldRecord.line,
      resolved: oldRecord.resolved,
      fileSha256: oldRecord.fileSha256,
      excerptSha256: oldRecord.excerptSha256
    } : null
  };
}));

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

const selectedEntities = [...selectedKeys].map(key => {
  const item = entities.get(key);
  const stageMatch = item.type === 'chain' && item.id.includes('/')
    ? item.row.stages?.find(stage => `${item.row.id}/${stage.id}` === item.id)
    : null;
  const row = stageMatch || item.row;
  const previousChain = item.type === 'chain' && previousManifest
    ? (previousManifest.chains || []).find(candidate => candidate.id === item.id.split('/')[0])
    : null;
  const previousRow = previousManifest
    ? (item.type === 'chain'
      ? (item.id.includes('/') ? previousChain?.stages?.find(stage => `${previousChain.id}/${stage.id}` === item.id) : previousChain)
      : (previousManifest[`${item.type}s`] || []).find(candidate => (candidate.id ?? candidate.name ?? candidate.prefix) === item.id))
    : null;
  return {
    key,
    type: item.type,
    id: item.id,
    title: row.title || row.name || row.label || row.area || row.prefix || item.id,
    summary: row.summary || row.description || '',
    previousSummary: previousRow?.summary || previousRow?.description || null,
    status: row.status || null,
    modules: row.modules || [],
    stale: staleEntities.has(key),
    sources: sourceRows.filter(source => entityKey(source.entityType, source.entityId) === key).map(source => source.key)
  };
});

const output = assertOutputInside(bundle.workspace, options.out || options.output || '.repo-atlas/context.json');
const context = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  purpose: 'incremental-analysis-context',
  baseline: { path: options.from || '.repo-atlas/snapshot.json', generatedAt: baseline.generatedAt, git: baseline.git || null },
  delta: { path: options.delta || '.repo-atlas/delta.json', generatedAt: delta.generatedAt, summary: delta.summary || null },
  filters: { changedOnly, staleOnly, previousManifest: previousManifestPath ? relative(bundle.workspace, previousManifestPath).replaceAll('\\', '/') : null },
  changedFiles,
  entities: selectedEntities,
  evidence,
  relationships,
  omitted: {
    unchangedEntities: Math.max(0, entities.size - selectedEntities.length),
    unchangedFiles: Math.max(0, Object.keys(baseline.files || {}).length - changedFiles.length)
  }
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, writeJson(context), { encoding: 'utf8', flag: 'w' });
console.log(JSON.stringify({ output, changedFiles: changedFiles.length, entities: selectedEntities.length, evidence: evidence.length, ...delta.summary }, null, 2));
