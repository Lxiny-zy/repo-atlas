import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { validateSchema } from './schema-lib.mjs';
import { sourceReader, resolveEvidence, redactValue } from './evidence-lib.mjs';
import { inside, planOutput } from './io-lib.mjs';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = value => Array.isArray(value) ? value : [];
const collections = ['modules', 'views', 'chains', 'findings', 'coverage', 'tables', 'routes', 'flags'];
export function manifestRows(manifest) {
  const rows = [];
  if (!isObject(manifest)) return rows;
  for (const collection of collections) list(manifest[collection]).forEach((row, index) => {
    if (!isObject(row)) return;
    const path = `/${collection}/${index}`;
    rows.push({ row, path, collection });
    if (collection === 'chains') list(row.stages).forEach((stage, i) => {
      if (isObject(stage)) rows.push({ row: stage, path: `${path}/stages/${i}`, collection: 'stages' });
    });
  });
  return rows;
}
function secretsIn(manifest) {
  return [...new Set(manifestRows(manifest).flatMap(({ row }) => list(row.sources).flatMap(source => list(source?.redact).filter(value => typeof value === 'string' && value.length))))];
}
const diagnosticStage = code => {
  if (code === 'input.read' || code === 'input.json') return 'input';
  if (code.startsWith('schema.') || code.startsWith('identity.') || code.startsWith('reference.')) return 'validate/structure';
  if (code.startsWith('evidence.')) return 'validate/evidence';
  if (code.startsWith('path.')) return 'validate/paths';
  if (code.startsWith('output.')) return 'validate/output';
  return 'validate';
};
const diagnosticFixes = code => {
  if (code === 'schema.required') return ['add the required field at the reported JSON Pointer'];
  if (code === 'schema.unknownProperty') return ['remove the unsupported field or use the documented spelling'];
  if (code.startsWith('schema.')) return ['edit the value at the reported JSON Pointer to satisfy the manifest schema'];
  if (code === 'identity.duplicate') return ['give the duplicate entries unique IDs within the collection'];
  if (code === 'reference.unknown') return ['replace the reference with an existing entity ID'];
  if (code === 'evidence.ambiguous') return ['add occurrence or replace the anchor with a unique source phrase'];
  if (code === 'evidence.missing') return ['restore the source anchor or remove the evidence reference'];
  if (code === 'evidence.fileMissing') return ['restore the source file or update the evidence path'];
  if (code.startsWith('evidence.')) return ['repair the source evidence at the reported location'];
  if (code === 'path.escape') return ['use a workspace-contained relative path'];
  if (code.startsWith('path.')) return ['correct the path and verify it exists inside the workspace'];
  if (code === 'output.invalid') return ['choose a workspace-contained .html output that does not collide with inputs'];
  if (code === 'input.read') return ['check that the manifest path exists and is readable'];
  if (code === 'input.json') return ['fix the JSON syntax and rerun validation'];
  return ['inspect the reported subject and rerun validation'];
};
function enrichDiagnostics(diagnostics) {
  return diagnostics.map(item => ({
    ...item,
    subject: item.path || '/',
    stage: diagnosticStage(item.code || ''),
    evidence: {
      path: item.path || '/',
      ...(item.relatedPath ? { relatedPath: item.relatedPath } : {})
    },
    supportedFixes: diagnosticFixes(item.code || '')
  }));
}
function finish(manifest, diagnostics) {
  const unique = [...new Map(diagnostics.map(item => [`${item.code}:${item.path}`, item])).values()];
  return redactValue(enrichDiagnostics(unique), secretsIn(manifest));
}

export function validateManifest(manifest, { sanitize = true } = {}) {
  const diagnostics = validateSchema(manifest);
  if (!isObject(manifest)) return diagnostics;
  const add = (code, path, message, relatedPath) => diagnostics.push({ severity: 'error', code, path, message, ...(relatedPath ? { relatedPath } : {}) });
  const unique = (rows, field, path) => {
    const seen = new Map();
    list(rows).forEach((row, index) => {
      if (typeof row?.[field] !== 'string') return;
      const at = `${path}/${index}/${field}`;
      if (seen.has(row[field])) add('identity.duplicate', at, '标识重复；同一集合内必须唯一。', seen.get(row[field]));
      else seen.set(row[field], at);
    });
    return seen;
  };
  const modules = unique(manifest.modules, 'id', '/modules');
  const views = unique(manifest.views, 'id', '/views');
  for (const collection of collections.filter(key => !['modules', 'views'].includes(key))) unique(manifest[collection], collection === 'routes' ? 'prefix' : ['tables', 'flags'].includes(collection) ? 'name' : 'id', `/${collection}`);
  const references = (ids, targets, path) => list(ids).forEach((id, index) => {
    if (typeof id === 'string' && !targets.has(id)) add('reference.unknown', `${path}/${index}`, '引用的目标不存在于清单中。');
  });
  for (const { row, path, collection } of manifestRows(manifest)) {
    references(row.modules, modules, `${path}/modules`);
    if (collection === 'modules') references(row.links, modules, `${path}/links`);
    if (collection === 'chains') { references(row.views, views, `${path}/views`); unique(row.stages, 'id', `${path}/stages`); }
    unique(row.sources, 'id', `${path}/sources`);
  }
  return sanitize ? finish(manifest, diagnostics) : diagnostics;
}

export function assertManifest(manifest) {
  const diagnostics = validateManifest(manifest);
  if (!diagnostics.length) return;
  const error = new Error(`Manifest validation failed (${diagnostics.length}):\n${diagnostics.map(item => `${item.path || '/'} [${item.code}] ${item.message}`).join('\n')}`);
  error.code = 'MANIFEST_INVALID'; error.diagnostics = diagnostics;
  throw error;
}

// Relative editor schema links must keep pointing at the same file when a
// candidate or accepted manifest moves. Never fetch or execute this address.
export function relocateSchema(manifest, from, to) {
  const value = manifest.$schema;
  if (typeof value !== 'string' || isAbsolute(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) return;
  manifest.$schema = relative(dirname(to), resolve(dirname(from), value)).split(sep).join('/');
}

export async function validateManifestFile(file, { structureOnly = false, review = false } = {}) {
  let manifest;
  let raw;
  const result = { file, valid: false, checks: { structure: false, references: false, sources: false, paths: false }, diagnostics: [] };
  const add = (code, path, message, severity = 'error') => result.diagnostics.push({ severity, code, path, message });
  try { raw = await readFile(resolve(file), 'utf8'); }
  catch { add('input.read', '', '无法读取清单文件。'); result.diagnostics = finish({}, result.diagnostics); return result; }
  try { manifest = JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch { add('input.json', '', 'JSON 语法无效；请检查引号、逗号和括号。'); result.diagnostics = finish({}, result.diagnostics); return result; }
  result.diagnostics = validateManifest(manifest, { sanitize: false });
  result.checks.structure = true; result.checks.references = true;
  // Bad unrelated fields must not hide evidence errors. Only malformed source
  // definitions and path fields are skipped individually.
  const invalidAt = path => result.diagnostics.some(item => item.severity === 'error' && (item.path === path || item.path.startsWith(`${path}/`)));
  if (!structureOnly && isObject(manifest) && typeof manifest.workspace === 'string' && !invalidAt('/workspace')) {
    let workspace;
    try { workspace = await realpath(resolve(dirname(resolve(file)), manifest.workspace)); if (!(await stat(workspace)).isDirectory()) throw new Error(); }
    catch { workspace = undefined; add('workspace.unavailable', '/workspace', '工作区目录不存在或不可读取。'); }
    if (workspace) {
      const checked = async value => {
        const requested = resolve(workspace, value);
        if (!inside(workspace, requested)) throw Object.assign(new Error(), { code: 'PATH_ESCAPE' });
        const full = await realpath(requested);
        if (!inside(workspace, full)) throw Object.assign(new Error(), { code: 'PATH_ESCAPE' });
        return full;
      };
      const read = sourceReader(checked);
      const protectedPaths = [resolve(file)];
      result.checks.sources = true; result.checks.paths = true;
      for (const { row, path } of manifestRows(manifest)) {
        const sources = list(row.sources);
        for (let i = 0; i < sources.length; i++) {
          const at = `${path}/sources/${i}`, source = sources[i];
          if (!isObject(source) || invalidAt(at)) continue;
          protectedPaths.push(resolve(workspace, source.path));
          try {
            const evidence = resolveEvidence((await read(source.path)).document, source);
            if (!evidence.resolved) add(`evidence.${evidence.state}`, at, evidence.reason, review ? 'warning' : 'error');
          } catch (error) {
            const missing = ['ENOENT', 'ENOTDIR'].includes(error.code);
            add(error.code === 'PATH_ESCAPE' ? 'path.escape' : missing ? 'evidence.fileMissing' : 'evidence.read', `${at}/path`, error.code === 'PATH_ESCAPE' ? '真实路径越出工作区。' : missing ? '源码文件不存在。' : '源码文件无法读取。', missing && review ? 'warning' : 'error');
          }
        }
      }
      const paths = [];
      list(manifest.fileGroups).forEach((group, i) => list(group?.paths).forEach((value, j) => paths.push({ value, path: `/fileGroups/${i}/paths/${j}` })));
      list(manifest.repositories).forEach((repo, i) => { if (isObject(repo)) paths.push({ value: repo.path, path: `/repositories/${i}/path`, directory: true }); });
      for (const entry of paths) {
        if (typeof entry.value !== 'string' || invalidAt(entry.path)) continue;
        try { const full = await checked(entry.value); if (entry.directory && !(await stat(full)).isDirectory()) throw new Error(); }
        catch (error) { add(error.code === 'PATH_ESCAPE' ? 'path.escape' : 'path.unavailable', entry.path, '路径不存在、不可读取或越出工作区。'); }
      }
      if (typeof manifest.output === 'string' && !invalidAt('/output')) {
        try { planOutput(workspace, manifest.output, { protectedPaths, extension: '.html' }); }
        catch { add('output.invalid', '/output', '输出位置无效、越出工作区或与输入文件冲突。'); }
      }
    }
  }
  result.diagnostics = finish(manifest, result.diagnostics);
  result.valid = !result.diagnostics.some(item => item.severity === 'error');
  return result;
}
