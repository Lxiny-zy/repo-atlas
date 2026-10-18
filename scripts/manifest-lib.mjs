import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { validateSchema } from './schema-lib.mjs';
import { sourceReader, resolveEvidence, redactValue } from './evidence-lib.mjs';
import { inside, planOutput } from './io-lib.mjs';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = value => Array.isArray(value) ? value : [];
const collections = ['modules', 'relations', 'views', 'chains', 'findings', 'coverage', 'tables', 'routes', 'flags'];
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
    if (collection === 'chains') list(row.transitions).forEach((transition, i) => {
      if (isObject(transition)) rows.push({ row: transition, path: `${path}/transitions/${i}`, collection: 'transitions' });
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
  const relations = new Map(list(manifest.relations).filter(isObject).map(row => [row.id, row]));
  const tables = new Map(list(manifest.tables).filter(isObject).map(row => [row.name, row]));
  for (const collection of collections.filter(key => !['modules', 'views'].includes(key))) unique(manifest[collection], collection === 'routes' ? 'prefix' : ['tables', 'flags'].includes(collection) ? 'name' : 'id', `/${collection}`);
  const references = (ids, targets, path) => list(ids).forEach((id, index) => {
    if (typeof id === 'string' && !targets.has(id)) add('reference.unknown', `${path}/${index}`, '引用的目标不存在于清单中。');
  });
  for (const { row, path, collection } of manifestRows(manifest)) {
    references(row.modules, modules, `${path}/modules`);
    if (collection === 'modules') references(row.links, modules, `${path}/links`);
    if (collection === 'relations') {
      for (const endpoint of ['from', 'to']) if (typeof row[endpoint] === 'string' && !modules.has(row[endpoint])) add('reference.unknown', `${path}/${endpoint}`, '关系端点必须是已登记的模块。');
    }
    if (collection === 'stages') references(row.relations, relations, `${path}/relations`);
    if (collection === 'views') {
      references(row.relations, relations, `${path}/relations`);
      references(row.tables, tables, `${path}/tables`);
      list(row.relations).forEach((id, index) => {
        const relation = relations.get(id);
        if (relation && [relation.from, relation.to].some(id => !list(row.modules).includes(id))) add('reference.outsideView', `${path}/relations/${index}`, '关系的两个端点必须包含在当前视图的 modules 中。');
      });
      if (!row.diagram && list(row.relations).length && ![undefined, 'overview', 'dependency', 'data_flow', 'flow'].includes(row.kind)) add('reference.diagramKind', `${path}/kind`, '自动关系图适用于 overview、dependency、data_flow 或 flow 视图。');
    }
    if (collection === 'tables') {
      unique(row.fields, 'name', `${path}/fields`);
      list(row.fields).forEach((field, index) => {
        if (Array.isArray(field?.evidenceBindings)) {
          const sourceIds = new Set(list(row.sources).map(source => source?.id).filter(Boolean));
          field.evidenceBindings.forEach((binding, bindingIndex) => list(binding?.sources).forEach((id, sourceIndex) => {
            if (!sourceIds.has(id)) add('reference.unknown', `${path}/fields/${index}/evidenceBindings/${bindingIndex}/sources/${sourceIndex}`, '字段证据绑定引用的 source.id 不存在。');
          }));
        }
        if (!isObject(field?.references)) return;
        const target = tables.get(field.references.table);
        if (!target) add('reference.unknown', `${path}/fields/${index}/references/table`, '字段关联的数据对象不存在。');
        else if (!list(target.fields).some(item => item?.name === field.references.field)) add('reference.unknown', `${path}/fields/${index}/references/field`, '关联的目标字段未登记。');
      });
    }
    if (collection === 'chains') { references(row.views, views, `${path}/views`); unique(row.stages, 'id', `${path}/stages`); }
    if (collection === 'chains') {
      const stageIds = new Set(list(row.stages).map(stage => stage?.id).filter(Boolean));
      unique(row.transitions, 'id', `${path}/transitions`);
      list(row.transitions).forEach((transition, index) => {
        if (isObject(transition)) {
          if (!stageIds.has(transition.from)) add('reference.unknown', `${path}/transitions/${index}/from`, '转移的起点阶段不存在。');
          if (!stageIds.has(transition.to)) add('reference.unknown', `${path}/transitions/${index}/to`, '转移的终点阶段不存在。');
        }
      });
    }
    if (Array.isArray(row.evidenceBindings)) {
      const sourceIds = new Set(list(row.sources).map(source => source?.id).filter(Boolean));
      row.evidenceBindings.forEach((binding, index) => list(binding?.sources).forEach((id, sourceIndex) => {
        if (!sourceIds.has(id)) add('reference.unknown', `${path}/evidenceBindings/${index}/sources/${sourceIndex}`, '证据绑定引用的 source.id 不存在。');
      }));
      unique(row.evidenceBindings, 'target', `${path}/evidenceBindings`);
      row.evidenceBindings.forEach((binding, index) => {
        if (typeof binding?.target !== 'string') return;
        let target = row;
        for (const token of binding.target.slice(1).split('/')) {
          const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
          target = target != null && Object.hasOwn(Object(target), key) ? target[key] : undefined;
        }
        if (target === undefined || typeof target === 'object') add('reference.target', `${path}/evidenceBindings/${index}/target`, '证据绑定必须定位到当前实体的已有标量字段。');
      });
    }
    unique(row.sources, 'id', `${path}/sources`);
  }
  list(manifest.views).forEach((view, viewIndex) => {
    if (typeof view?.chain === 'string') {
      const chain = list(manifest.chains).find(row => row?.id === view.chain);
      if (!chain) add('reference.unknown', `/views/${viewIndex}/chain`, '自动流程图引用的链路不存在。');
      else {
        if (!list(chain.transitions).length) add('reference.transitions', `/views/${viewIndex}/chain`, '自动流程图需要显式 transitions。');
        if (!list(chain.views).includes(view.id)) add('reference.unlinked', `/views/${viewIndex}/chain`, '链路必须关联该视图。');
      }
      if (view.diagram || view.relations?.length || view.bindings?.length || view.mobileDiagram) add('reference.conflict', `/views/${viewIndex}/chain`, 'chain 自动图不能同时定义 diagram、relations、bindings 或 mobileDiagram。');
      if (view.kind && view.kind !== 'flow') add('reference.diagramKind', `/views/${viewIndex}/kind`, 'chain 自动图使用 flow 类型。');
    }
    const path = `/views/${viewIndex}/bindings`;
    unique(view?.bindings, 'node', path);
    list(view?.bindings).forEach((binding, index) => {
      if (!isObject(binding)) return;
      const chain = list(manifest.chains).find(row => row?.id === binding.chain);
      if (!chain) add('reference.unknown', `${path}/${index}/chain`, '节点绑定的业务链路不存在。');
      else {
        if (!list(chain.stages).some(stage => stage?.id === binding.stage)) add('reference.unknown', `${path}/${index}/stage`, '节点绑定的阶段不存在于该链路。');
        if (!list(chain.views).includes(view.id)) add('reference.unlinked', `${path}/${index}/chain`, '节点绑定的链路必须在 views 中关联当前视图。');
      }
      if (!view.diagram) add('reference.diagram', `${path}/${index}/node`, '节点绑定需要当前视图提供 diagram。');
    });
  });
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
