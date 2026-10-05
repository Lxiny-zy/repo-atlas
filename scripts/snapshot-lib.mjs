import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, extname, relative, resolve, isAbsolute, sep } from 'node:path';
import { hashBytes, hashText, hashFile, normalizeSource, redactionValues, redactionHash, redactText, redactValue, resolveEvidence, sourceReader } from './evidence-lib.mjs';
import { inside } from './io-lib.mjs';
import { gitInfo } from './git-lib.mjs';
import { assertManifest } from './manifest-lib.mjs';
export { hashBytes, hashText, inside, gitInfo };
export { assertOutputInside } from './io-lib.mjs';
export { parseOptions } from './cli-lib.mjs';

export const slash = value => value.split(sep).join('/');
const runtimeFields = new Set(['freshness', 'reviewRequired', 'staleReason']);
const runtimeCollections = ['modules', 'views', 'chains', 'tables', 'routes', 'flags', 'findings', 'coverage'];
export function analysisManifestHash(manifest) {
  const normalized = structuredClone(manifest);
  delete normalized.update;
  delete normalized.review;
  delete normalized.$schema;
  delete normalized.workspace;
  delete normalized.output;
  for (const collection of runtimeCollections) {
    for (const row of normalized[collection] || []) {
      for (const item of [row, ...(row.stages || [])]) for (const field of runtimeFields) delete item[field];
    }
  }
  return hashText(JSON.stringify(normalized));
}
const isMissing = error => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
const validateRelativePath = value => {
  if (typeof value !== 'string' || !value.trim() || isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.includes('\\')) {
    throw new Error(`Use a workspace-relative path with /: ${value}`);
  }
  return value;
};

export async function loadManifest(manifestPath) {
  const absolute = resolve(manifestPath);
  const raw = await readFile(absolute, 'utf8');
  const manifest = JSON.parse(raw.replace(/^\uFEFF/, ''));
  assertManifest(manifest);
  if (!manifest.workspace || typeof manifest.workspace !== 'string') throw new Error('manifest.workspace is required');
  const workspace = await realpath(resolve(dirname(absolute), manifest.workspace));
  return { manifestPath: absolute, raw, manifest, workspace };
}

export function repoRelative(workspace, value) {
  validateRelativePath(value);
  const full = resolve(workspace, value);
  if (!inside(workspace, full)) throw new Error(`Path escapes workspace: ${value}`);
  return slash(relative(workspace, full) || '.');
}

export async function checkedPath(workspace, value) {
  validateRelativePath(value);
  const requested = resolve(workspace, value);
  if (!inside(workspace, requested)) throw new Error(`Path escapes workspace: ${value}`);
  const full = await realpath(requested);
  if (!inside(workspace, full)) throw new Error(`Path escapes workspace: ${value}`);
  return full;
}

function sourceRows(manifest) {
  const rows = [];
  const add = (kind, id, sources, keyKind = kind) => (sources || []).forEach((spec, index) => {
    const source = normalizeSource(spec);
    rows.push({ ...source, key: `${keyKind}:${id}:${source.id ?? index}`, entityType: kind, entityId: id, index });
  });
  (manifest.modules || []).forEach(row => add('module', row.id, row.sources));
  (manifest.views || []).forEach(row => add('view', row.id, row.sources));
  (manifest.chains || []).forEach(row => {
    add('chain', row.id, row.sources);
    (row.stages || []).forEach(stage => add('chain-stage', `${row.id}/${stage.id}`, stage.sources, 'chain'));
  });
  (manifest.tables || []).forEach(row => add('table', row.name, row.sources));
  (manifest.routes || []).forEach(row => add('route', row.prefix, row.sources));
  (manifest.flags || []).forEach(row => add('flag', row.name, row.sources));
  (manifest.findings || []).forEach(row => add('finding', row.id, row.sources));
  (manifest.coverage || []).forEach(row => add('coverage', row.id, row.sources));
  if (new Set(rows.map(row => row.key)).size !== rows.length) throw new Error('Duplicate evidence identity');
  return rows;
}

export function collectSourceRows(manifest) { return sourceRows(manifest); }

export function buildSummaryIndex(manifest) {
  const summaries = {};
  const add = (type, id, row) => {
    summaries[`${type}:${id}`] = {
      title: row.title || row.name || row.label || row.area || row.prefix || id,
      summary: row.summary || row.description || '',
      status: row.status || null,
      modules: row.modules || []
    };
  };
  for (const row of manifest.modules || []) add('module', row.id, row);
  for (const row of manifest.views || []) add('view', row.id, row);
  for (const row of manifest.chains || []) {
    add('chain', row.id, row);
    for (const stage of row.stages || []) add('chain-stage', `${row.id}/${stage.id}`, stage);
  }
  for (const [type, rows, key] of [
    ['table', manifest.tables, 'name'],
    ['route', manifest.routes, 'prefix'],
    ['flag', manifest.flags, 'name'],
    ['finding', manifest.findings, 'id'],
    ['coverage', manifest.coverage, 'id']
  ]) for (const row of rows || []) add(type, row[key], row);
  return summaries;
}

async function walkFiles(workspace, group, files, seen, reads, allowMissingSources = false) {
  const extensions = new Set((group.extensions || []).map(value => value.toLowerCase()));
  const excludes = new Set(['.git', '.repo-atlas', 'node_modules', '.venv', '__pycache__', ...(group.exclude || [])]);
  async function visit(relativePath) {
    let full;
    try {
      full = await reads.path(relativePath);
    } catch (error) {
      if (allowMissingSources && isMissing(error)) return;
      throw error;
    }
    const canonical = full;
    if (seen.has(canonical)) return;
    seen.add(canonical);
    const info = await reads.stat(canonical);
    if (info.isDirectory()) {
      for (const entry of await reads.directory(canonical)) {
        if (excludes.has(entry.name) || entry.isSymbolicLink()) continue;
        await visit(slash(relative(workspace, resolve(canonical, entry.name))));
      }
      return;
    }
    if (!info.isFile() || !extensions.has(extname(relativePath).toLowerCase())) return;
    const path = slash(relative(workspace, canonical));
    if (!files.has(path)) files.set(path, { path, group: group.name, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs });
  }
  for (const path of group.paths || []) await visit(path);
}

async function fileHash(workspace, record, previous, force = false) {
  const old = previous?.files?.[record.path];
  // Evidence files are always rehashed; conclusions should not depend on
  // filesystem timestamps. Other inventory files can reuse a matching cache
  // entry, while older snapshots without ctimeMs are rehashed once.
  if (!force && old && old.ctimeMs != null && record.ctimeMs != null && old.size === record.size && old.mtimeMs === record.mtimeMs && old.ctimeMs === record.ctimeMs && old.sha256) return old.sha256;
  return hashFile(resolve(workspace, record.path));
}

export async function collectFileInventory({ manifest, workspace, previous, allowMissingSources = false }) {
  const files = new Map();
  // Share physical reads within this inventory only. Filters and visited sets
  // remain per group, and later snapshots always observe a fresh filesystem.
  const memoize = read => {
    const cache = new Map();
    return key => { if (!cache.has(key)) cache.set(key, read(key)); return cache.get(key); };
  };
  const reads = {
    path: memoize(path => checkedPath(workspace, path)),
    stat: memoize(path => stat(path)),
    directory: memoize(path => readdir(path, { withFileTypes: true }))
  };
  const sources = sourceRows(manifest);
  const evidencePaths = new Set();
  for (const source of sources) {
    evidencePaths.add(repoRelative(workspace, source.path));
    try {
      evidencePaths.add(slash(relative(workspace, await reads.path(source.path))));
    } catch (error) {
      if (!(allowMissingSources && isMissing(error))) throw error;
    }
  }
  for (const group of manifest.fileGroups || []) await walkFiles(workspace, group, files, new Set(), reads, allowMissingSources);
  for (const source of sources) {
    let full;
    try {
      full = await reads.path(source.path);
    } catch (error) {
      if (allowMissingSources && isMissing(error)) continue;
      throw error;
    }
    const info = await reads.stat(full);
    const path = slash(relative(workspace, full));
    if (!files.has(path)) files.set(path, { path, group: 'evidence-only', size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs });
  }
  const inventory = {};
  const pending = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  const hashed = new Map();
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(8, pending.length) }, async () => {
    for (;;) {
      const record = pending[cursor++];
      if (!record) return;
      hashed.set(record.path, { ...record, sha256: await fileHash(workspace, record, previous, evidencePaths.has(record.path)) });
    }
  }));
  for (const path of [...hashed.keys()].sort()) inventory[path] = hashed.get(path);
  return inventory;
}

export async function buildEvidenceInventory({ manifest, workspace, files, allowMissingSources = false }) {
  const evidence = {}, impactIndex = {};
  const sources = sourceRows(manifest);
  const secrets = redactionValues(sources);
  const read = sourceReader(path => checkedPath(workspace, path));
  for (const source of sources) {
    let path = repoRelative(workspace, source.path), file = null, result;
    try {
      file = await read(source.path);
      path = slash(relative(workspace, file.full));
      if (file.sha256 !== files[path]?.sha256) throw new Error(`Source drift while creating snapshot: ${path}`);
      result = resolveEvidence(file.document, { ...source, redact: secrets });
    } catch (error) {
      if (!(allowMissingSources && isMissing(error))) throw error;
      result = { state: 'missing', resolved: false, line: null, text: null, excerptSha256: null, reason: 'source file missing' };
    }
    evidence[source.key] = {
      key: source.key, entityType: source.entityType, entityId: source.entityId, path,
      match: redactText(source.match, secrets), definitionSha256: hashText(JSON.stringify([path, source.match, source.occurrence, source.length])),
      occurrence: source.occurrence, length: source.length, redactSha256: redactionHash(source.redact),
      line: result.line, state: result.state, resolved: result.resolved,
      fileSha256: file?.sha256 || null, excerptSha256: result.excerptSha256,
      storedExcerpt: result.text, storedExcerptSha256: result.text == null ? null : hashText(result.text),
      staleReason: result.reason
    };
    (impactIndex[path] ||= []).push(`${source.entityType}:${source.entityId}`);
    if (source.entityType === 'chain-stage') impactIndex[path].push(`chain:${source.entityId.split('/')[0]}`);
  }
  // Optional ownership includes files that have no directly cited excerpt.
  for (const module of manifest.modules || []) {
    if (module.paths != null && !Array.isArray(module.paths)) throw new Error('module.paths must be an array');
    for (const value of module.paths || []) {
      let path = repoRelative(workspace, value);
      try { path = slash(relative(workspace, await checkedPath(workspace, value))); }
      catch (error) { if (!isMissing(error)) throw error; }
      for (const file of Object.keys(files)) if (path === '.' || file === path || file.startsWith(path + '/')) (impactIndex[file] ||= []).push(`module:${module.id}`);
    }
  }
  for (const path of Object.keys(impactIndex)) impactIndex[path] = [...new Set(impactIndex[path])].sort();
  return { evidence, impactIndex };
}

export const workspaceHash = workspace => hashText(process.platform === 'win32' ? workspace.toLowerCase() : workspace);
export const snapshotHash = snapshot => hashText(JSON.stringify(snapshot));
export const inventoryHash = files => hashText(JSON.stringify(Object.keys(files).sort().map(path => [path, files[path].sha256])));

export function assertBaselineWorkspace(bundle, baseline) {
  if (baseline.schemaVersion !== 2 || baseline.workspaceSha256 !== workspaceHash(bundle.workspace)) {
    throw new Error('Baseline schema/workspace mismatch; create a v2 snapshot in this workspace');
  }
}

export async function createSnapshot(bundle, previous = null, { allowMissingSources = false } = {}) {
  const files = await collectFileInventory({ ...bundle, previous, allowMissingSources });
  const evidence = await buildEvidenceInventory({ ...bundle, files, allowMissingSources });
  const git = gitInfo(bundle.workspace);
  const repositories = { '.': { path: '.', git } };
  for (const repo of bundle.manifest.repositories || []) {
    const full = await checkedPath(bundle.workspace, repo.path);
    const path = slash(relative(bundle.workspace, full) || '.');
    repositories[path] = { path, name: repo.name || path, git: gitInfo(full) };
  }
  const repoPaths = Object.keys(repositories).sort((a, b) => b.length - a.length);
  for (const file of Object.values(files)) file.repository = repoPaths.find(path => path === '.' || file.path.startsWith(path + '/'));
  const secrets = redactionValues(sourceRows(bundle.manifest));
  return {
    schemaVersion: 2, generatedAt: new Date().toISOString(),
    workspaceSha256: workspaceHash(bundle.workspace),
    manifestPath: slash(relative(bundle.workspace, bundle.manifestPath)),
    manifestSha256: hashText(bundle.raw), analysisManifestSha256: analysisManifestHash(bundle.manifest),
    inventorySha256: inventoryHash(files), redactionPolicySha256: redactionHash(secrets),
    git, repositories, files, evidence: evidence.evidence, impactIndex: evidence.impactIndex,
    summaryIndex: redactValue(buildSummaryIndex(bundle.manifest), secrets),
    counts: { files: Object.keys(files).length, evidence: Object.keys(evidence.evidence).length }
  };
}

// Consumers rebuild the inventory without timestamp reuse. Output is refused if
// sources, semantic manifest, workspace or baseline changed since delta creation.
export async function validateDelta(bundle, baseline, delta) {
  assertBaselineWorkspace(bundle, baseline);
  if (delta.schemaVersion !== 2 || delta.from?.snapshotSha256 !== snapshotHash(baseline)) throw new Error('Delta baseline mismatch; regenerate delta');
  if (delta.workspaceSha256 !== workspaceHash(bundle.workspace) || delta.to?.analysisManifestSha256 !== analysisManifestHash(bundle.manifest)) throw new Error('Delta manifest/workspace drift; regenerate delta');
  const current = await createSnapshot(bundle, null, { allowMissingSources: true });
  if (delta.to?.inventorySha256 !== current.inventorySha256) throw new Error('Source drift since delta; regenerate delta');
  return current;
}

export function protectedSourcePaths(bundle, files = {}) {
  return [bundle.manifestPath, ...Object.keys(files).map(path => resolve(bundle.workspace, path)), ...sourceRows(bundle.manifest).map(source => resolve(bundle.workspace, source.path))];
}
export function writeJson(value) { return JSON.stringify(value, null, 2) + '\n'; }
