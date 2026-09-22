import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, extname, relative, resolve, isAbsolute, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

export const slash = value => value.split(sep).join('/');
export const hashBytes = value => createHash('sha256').update(value).digest('hex');
export const hashText = value => hashBytes(Buffer.from(value, 'utf8'));
const runtimeFields = new Set(['freshness', 'reviewRequired', 'staleReason']);
const runtimeCollections = ['modules', 'views', 'chains', 'tables', 'routes', 'flags', 'findings', 'coverage'];
export function analysisManifestHash(manifest) {
  const normalized = structuredClone(manifest);
  delete normalized.update;
  for (const collection of runtimeCollections) {
    for (const row of normalized[collection] || []) for (const field of runtimeFields) delete row[field];
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
export const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
};

export async function loadManifest(manifestPath) {
  const absolute = resolve(manifestPath);
  const raw = await readFile(absolute, 'utf8');
  const manifest = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (!manifest.workspace || typeof manifest.workspace !== 'string') throw new Error('manifest.workspace is required');
  const workspace = await realpath(resolve(dirname(absolute), manifest.workspace));
  return { manifestPath: absolute, raw, manifest, workspace };
}

export function parseOptions(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) { options._.push(arg); continue; }
    const [key, inline] = arg.slice(2).split('=', 2);
    if (inline !== undefined) options[key] = inline;
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) options[key] = argv[++index];
    else options[key] = true;
  }
  return options;
}

export function repoRelative(workspace, value) {
  validateRelativePath(value);
  const full = resolve(workspace, value);
  if (!inside(workspace, full)) throw new Error(`Path escapes workspace: ${value}`);
  return slash(relative(workspace, full) || '.');
}

export async function checkedPath(workspace, value) {
  validateRelativePath(value);
  const full = await realpath(resolve(workspace, value));
  if (!inside(workspace, full)) throw new Error(`Path escapes workspace: ${value}`);
  return full;
}

function sourceRows(manifest) {
  const rows = [];
  const add = (kind, id, sources, keyId = id) => (sources || []).forEach((source, index) => rows.push({
    key: `${kind}:${keyId}:${index}`,
    entityType: kind,
    entityId: id,
    index,
    path: source.path,
    match: source.match,
    occurrence: source.occurrence ?? 1,
    length: source.length ?? 8,
    redact: source.redact || []
  }));
  (manifest.modules || []).forEach(row => add('module', row.id, row.sources));
  (manifest.views || []).forEach(row => add('view', row.id, row.sources));
  (manifest.chains || []).forEach(row => {
    add('chain', row.id, row.sources);
    (row.stages || []).forEach(stage => add('chain', row.id, stage.sources, `${row.id}/${stage.id}`));
  });
  (manifest.tables || []).forEach(row => add('table', row.name, row.sources));
  (manifest.routes || []).forEach(row => add('route', row.prefix, row.sources));
  (manifest.flags || []).forEach(row => add('flag', row.name, row.sources));
  (manifest.findings || []).forEach(row => add('finding', row.id, row.sources));
  (manifest.coverage || []).forEach(row => add('coverage', row.id, row.sources));
  return rows;
}

export function collectSourceRows(manifest) { return sourceRows(manifest); }

async function walkFiles(workspace, group, files, seen, allowMissingSources = false) {
  const extensions = new Set((group.extensions || []).map(value => value.toLowerCase()));
  const excludes = new Set(['.git', '.repo-atlas', 'node_modules', '.venv', '__pycache__', ...(group.exclude || [])]);
  async function visit(relativePath) {
    let full;
    try {
      full = await checkedPath(workspace, relativePath);
    } catch (error) {
      if (allowMissingSources && isMissing(error)) return;
      throw error;
    }
    const canonical = await realpath(full);
    if (seen.has(canonical)) return;
    seen.add(canonical);
    const info = await stat(canonical);
    if (info.isDirectory()) {
      for (const entry of await readdir(canonical, { withFileTypes: true })) {
        if (excludes.has(entry.name) || entry.isSymbolicLink()) continue;
        await visit(slash(relative(workspace, resolve(canonical, entry.name))));
      }
      return;
    }
    if (!info.isFile() || !extensions.has(extname(relativePath).toLowerCase())) return;
    const path = slash(relative(workspace, canonical));
    files.set(path, { path, group: group.name, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs });
  }
  for (const path of group.paths || []) await visit(path);
}

async function fileHash(workspace, record, previous, force = false) {
  const old = previous?.files?.[record.path];
  // Evidence files are always rehashed; conclusions should not depend on
  // filesystem timestamps. Other inventory files can reuse a matching cache
  // entry, while older snapshots without ctimeMs are rehashed once.
  if (!force && old && old.ctimeMs != null && record.ctimeMs != null && old.size === record.size && old.mtimeMs === record.mtimeMs && old.ctimeMs === record.ctimeMs && old.sha256) return old.sha256;
  return hashBytes(await readFile(resolve(workspace, record.path)));
}

export async function collectFileInventory({ manifest, workspace, previous, allowMissingSources = false }) {
  const files = new Map();
  const seen = new Set();
  const sources = sourceRows(manifest);
  const evidencePaths = new Set();
  for (const source of sources) {
    evidencePaths.add(repoRelative(workspace, source.path));
    try {
      evidencePaths.add(slash(relative(workspace, await checkedPath(workspace, source.path))));
    } catch (error) {
      if (!(allowMissingSources && isMissing(error))) throw error;
    }
  }
  for (const group of manifest.fileGroups || []) await walkFiles(workspace, group, files, seen, allowMissingSources);
  for (const source of sources) {
    let full;
    try {
      full = await checkedPath(workspace, source.path);
    } catch (error) {
      if (allowMissingSources && isMissing(error)) continue;
      throw error;
    }
    const info = await stat(full);
    const path = slash(relative(workspace, full));
    if (!files.has(path)) files.set(path, { path, group: 'evidence-only', size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs });
  }
  const inventory = {};
  for (const record of files.values()) {
    inventory[record.path] = { ...record, sha256: await fileHash(workspace, record, previous, evidencePaths.has(record.path)) };
  }
  return inventory;
}

export function gitInfo(workspace) {
  const git = args => execFileSync('git', ['--no-optional-locks', ...args], { cwd: workspace, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024 }).trim();
  try {
    return {
      available: true,
      commit: git(['rev-parse', 'HEAD']),
      shortCommit: git(['rev-parse', '--short=12', 'HEAD']),
      branch: git(['branch', '--show-current']) || '(detached HEAD)',
      dirty: Boolean(git(['status', '--porcelain']).trim()),
      treeHash: git(['rev-parse', 'HEAD^{tree}'])
    };
  } catch {
    return { available: false, commit: null, shortCommit: null, branch: null, dirty: false, treeHash: null };
  }
}

export async function buildEvidenceInventory({ manifest, workspace, files, allowMissingSources = false }) {
  const evidence = {};
  const impactIndex = {};
  const textCache = new Map();
  for (const source of sourceRows(manifest)) {
    const path = repoRelative(workspace, source.path);
    let full;
    try {
      full = await checkedPath(workspace, source.path);
    } catch (error) {
      if (!(allowMissingSources && isMissing(error))) throw error;
      evidence[source.key] = {
        key: source.key,
        entityType: source.entityType,
        entityId: source.entityId,
        path,
        match: source.match,
        occurrence: source.occurrence,
        length: source.length,
        redactSha256: hashText(JSON.stringify(source.redact || [])),
        line: null,
        resolved: false,
        fileSha256: null,
        excerptSha256: null,
        staleReason: 'source file missing'
      };
      (impactIndex[path] ||= []).push(`${source.entityType}:${source.entityId}`);
      continue;
    }
    const file = files[path];
    const content = textCache.has(path) ? textCache.get(path) : await readFile(full, 'utf8');
    textCache.set(path, content);
    const lines = content.split(/\r?\n/);
    const matches = lines.flatMap((line, index) => line.includes(source.match) ? [index] : []);
    const matchIndex = matches[source.occurrence - 1];
    const resolved = matchIndex != null;
    const excerpt = resolved ? lines.slice(matchIndex, matchIndex + source.length).join('\n') : '';
    evidence[source.key] = {
      key: source.key,
      entityType: source.entityType,
      entityId: source.entityId,
      path,
      match: source.match,
      occurrence: source.occurrence,
      length: source.length,
      redactSha256: hashText(JSON.stringify(source.redact || [])),
      line: resolved ? matchIndex + 1 : null,
      resolved,
      fileSha256: file?.sha256 || null,
      excerptSha256: resolved ? hashText(excerpt) : null,
      staleReason: resolved ? null : 'source anchor missing or ambiguous'
    };
    (impactIndex[path] ||= []).push(`${source.entityType}:${source.entityId}`);
  }
  return { evidence, impactIndex };
}

export async function createSnapshot(bundle, previous = null, { allowMissingSources = false } = {}) {
  const files = await collectFileInventory({ ...bundle, previous, allowMissingSources });
  const evidence = await buildEvidenceInventory({ ...bundle, files, allowMissingSources });
  const git = gitInfo(bundle.workspace);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    manifestPath: slash(relative(bundle.workspace, bundle.manifestPath)),
    manifestSha256: hashText(bundle.raw),
    analysisManifestSha256: analysisManifestHash(bundle.manifest),
    git,
    files,
    evidence: evidence.evidence,
    impactIndex: evidence.impactIndex,
    counts: { files: Object.keys(files).length, evidence: Object.keys(evidence.evidence).length }
  };
}

export function assertOutputInside(workspace, output) {
  const full = resolve(workspace, output);
  if (!inside(workspace, full)) throw new Error(`Output escapes workspace: ${output}`);
  return full;
}

export function writeJson(value) { return JSON.stringify(value, null, 2) + '\n'; }
