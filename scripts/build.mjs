import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { createReadStream } from 'node:fs';
import { normalizeSource, sourceReader, resolveEvidence, redactionValues, redactValue } from './evidence-lib.mjs';
import { planOutput, atomicWrite } from './io-lib.mjs';
import { collectSourceRows, createSnapshot, analysisManifestHash } from './snapshot-lib.mjs';
import { assertManifest } from './manifest-lib.mjs';
import { parseOptions } from './cli-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const options = parseOptions(process.argv.slice(2), { boolean: ['replace', 'review'], usage: 'Usage: node scripts/build.mjs <atlas.json> [--replace] [--review]' });
const input = options._[0];
const replace = Boolean(options.replace);
const reviewMode = Boolean(options.review);
const manifestPath = resolve(input);
const manifest = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''));
assertManifest(manifest);
const requireText = (value, context) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${context} must be a nonempty string`);
  return value;
};
const requireList = (value, context) => {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  return value;
};
const slash = value => value.split(sep).join('/');
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
};
const workspace = await realpath(resolve(dirname(manifestPath), requireText(manifest.workspace, 'workspace')));
const protectedPaths = [manifestPath, ...collectSourceRows(manifest).map(source => resolve(workspace, source.path))];
const output = planOutput(workspace, requireText(manifest.output, 'output'), { extension: '.html', replace, protectedPaths });
if (manifest.review && !manifest.update) {
  const current = await createSnapshot({ manifestPath, manifest, workspace, raw: JSON.stringify(manifest) }, null, { allowMissingSources: true });
  if (current.inventorySha256 !== manifest.review.binding?.inventorySha256 || analysisManifestHash(manifest) !== manifest.review.binding?.analysisManifestSha256 || current.workspaceSha256 !== manifest.review.binding?.workspaceSha256) throw new Error('Reviewed version drift; refresh and review before rebuilding an accepted report');
}

async function checkedPath(value) {
  requireText(value, 'source path');
  if (isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.includes('\\')) throw new Error(`Use a workspace-relative path with /: ${value}`);
  const requested = resolve(workspace, value);
  if (!inside(workspace, requested)) throw new Error(`Source escapes workspace: ${value}`);
  const full = await realpath(requested);
  if (!inside(workspace, full)) throw new Error(`Source escapes workspace: ${value}`);
  return full;
}
const read = sourceReader(checkedPath);
const secrets = redactionValues(collectSourceRows(manifest));
let unresolvedCount = 0;
async function evidence(spec) {
  const source = normalizeSource(spec);
  let result;
  try { result = resolveEvidence((await read(source.path)).document, { ...source, redact: secrets }); }
  catch (error) {
    if (!reviewMode || !['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    result = { resolved: false, reason: 'Source file missing' };
  }
  if (!result.resolved) {
    if (!reviewMode) throw new Error(`${result.reason}: ${source.path}`);
    unresolvedCount++;
    return { path: source.path, sourceId: source.id, line: null, excerpt: null, state: 'unresolved', reason: result.reason };
  }
  return { path: source.path, sourceId: source.id, line: result.line, excerpt: result.text, state: 'resolved' };
}
async function lineCount(full) {
  let lines = 1;
  for await (const chunk of createReadStream(full)) for (const byte of chunk) if (byte === 10) lines++;
  return lines;
}
const identifiers = new Set();
const freshnessFields = row => ({
  ...(row.freshness ? { freshness: row.freshness } : {}),
  ...(row.reviewRequired ? { reviewRequired: true } : {}),
  ...(row.staleReason ? { staleReason: row.staleReason } : {})
});
function uniqueId(id, group) {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw new Error(`Invalid ${group} id: ${id}`);
  const key = group + ':' + id;
  if (identifiers.has(key)) throw new Error(`Duplicate ${group} id: ${id}`);
  identifiers.add(key);
}
const project = manifest.project || {};
requireText(project.title, 'project.title');
requireText(project.scope, 'project.scope');
requireText(project.boundary, 'project.boundary');
if (project.subtitle != null) requireText(project.subtitle, 'project.subtitle');
if (project.summary != null) requireText(project.summary, 'project.summary');
const modules = await Promise.all(requireList(manifest.modules, 'modules').map(async module => {
  uniqueId(module.id, 'module');
  requireText(module.name, 'module.name');
  requireText(module.summary, 'module.summary');
  const facts = requireList(module.facts, 'module.facts');
  facts.forEach(fact => requireText(fact, 'module fact'));
  const links = requireList(module.links || [], `module.links in ${module.id}`);
  if (module.icon != null) requireText(module.icon, `module.icon in ${module.id}`);
  if (!requireList(module.sources, 'module.sources').length) throw new Error(`No evidence for module ${module.id}`);
  return { id: module.id, name: module.name, summary: module.summary, category: module.category || '业务模块', icon: module.icon || 'box', facts, links, ...freshnessFields(module), sources: await Promise.all(module.sources.map(evidence)) };
}));
if (!modules.length) throw new Error('At least one evidenced module is required');
const moduleIds = new Set(modules.map(module => module.id));
for (const module of modules) for (const id of module.links) if (!moduleIds.has(id)) throw new Error(`Unknown module link: ${module.id} -> ${id}`);

const flowClasses = await readFile(resolve(here, '../assets/report/flow-classes.mmd'), 'utf8');
const inferViewKind = diagram => {
  const value = diagram.trimStart();
  if (value.startsWith('sequenceDiagram')) return 'sequence';
  if (value.startsWith('stateDiagram')) return 'state';
  if (value.startsWith('erDiagram')) return 'data';
  if (value.startsWith('mindmap')) return 'mindmap';
  if (/^\s*(flowchart|graph)\s/.test(value)) return 'flow';
  return 'custom';
};
const viewKinds = new Set(['overview', 'flow', 'narrative', 'sequence', 'state', 'data', 'deployment', 'recovery', 'dependency', 'mindmap', 'custom']);
const views = await Promise.all(requireList(manifest.views || [], 'views').map(async view => {
  uniqueId(view.id, 'view');
  if (view.id === 'catalog') throw new Error('catalog is reserved for the generated index');
  requireText(view.title, 'view.title');
  if (view.kind !== 'narrative') requireText(view.diagram, 'view.diagram');
  else if (view.diagram != null) requireText(view.diagram, 'view.diagram');
  const inferredKind = inferViewKind(view.diagram || '');
  // Legacy sequence views remain addressable, but never reach the SVG renderer.
  const kind = inferredKind === 'sequence' ? 'sequence' : view.kind || inferredKind;
  if (!viewKinds.has(kind)) throw new Error(`Invalid view.kind in ${view.id}: ${kind}`);
  if (view.mobileDiagram != null) requireText(view.mobileDiagram, `view.mobileDiagram in ${view.id}`);
  for (const id of requireList(view.modules, 'view.modules')) if (!moduleIds.has(id)) throw new Error(`Unknown module in view ${view.id}: ${id}`);
  const notes = requireList(view.notes || [], 'view.notes');
  for (const note of notes) if (!Array.isArray(note) || note.length !== 2 || note.some(value => typeof value !== 'string')) throw new Error(`Invalid note in ${view.id}`);
  const tags = requireList(view.tags || [], `view.tags in ${view.id}`);
  tags.forEach(tag => requireText(tag, `view tag in ${view.id}`));
  const aliases = view.aliases || {};
  if (typeof aliases !== 'object' || Array.isArray(aliases) || Object.entries(aliases).some(([key, value]) => !key.trim() || typeof value !== 'string' || !value.trim())) throw new Error(`Invalid aliases in ${view.id}`);
  const legend = requireList(view.legend || [], `view.legend in ${view.id}`);
  for (const item of legend) if (!item || typeof item !== 'object' || typeof item.label !== 'string' || !/^#[a-fA-F0-9]{6}$/.test(item.color)) throw new Error(`Invalid legend item in ${view.id}`);
  const theme = diagram => /^\s*(flowchart|graph)\s/.test(diagram) && view.useDefaultClasses !== false ? diagram + '\n' + flowClasses : diagram;
  return {
    id: view.id, title: view.title, subtitle: view.subtitle || '', icon: view.icon || 'network', group: view.group || '项目图谱',
    kind, tags, diagram: kind === 'narrative' ? undefined : theme(view.diagram),
    mobileDiagram: !['sequence', 'narrative'].includes(kind) && view.mobileDiagram && inferViewKind(view.mobileDiagram) !== 'sequence' ? theme(view.mobileDiagram) : undefined,
    modules: view.modules, notes, aliases: Object.keys(aliases).length ? aliases : undefined, legend: legend.length ? legend : undefined, ...freshnessFields(view),
    sources: await Promise.all(requireList(view.sources || [], `view.sources in ${view.id}`).map(evidence))
  };
}));
const viewIds = new Set(views.map(view => view.id));
const chainStatuses = new Set(['covered', 'partial', 'unknown', 'not_applicable']);
const chains = await Promise.all(requireList(manifest.chains || [], 'chains').map(async chain => {
  uniqueId(chain.id, 'chain');
  requireText(chain.title, 'chain.title');
  requireText(chain.summary, 'chain.summary');
  requireText(chain.trigger, 'chain.trigger');
  requireText(chain.outcome, 'chain.outcome');
  const related = requireList(chain.modules || [], `chain.modules in ${chain.id}`);
  for (const id of related) if (!moduleIds.has(id)) throw new Error(`Unknown module in chain ${chain.id}: ${id}`);
  const chainViews = [...requireList(chain.views || [], `chain.views in ${chain.id}`)];
  for (const id of chainViews) if (!viewIds.has(id)) throw new Error(`Unknown view in chain ${chain.id}: ${id}`);
  const stages = requireList(chain.stages, `chain.stages in ${chain.id}`);
  if (stages.length < 3) throw new Error(`Chain ${chain.id} must contain at least 3 stages`);
  const stageIds = new Set();
  const normalizedStages = await Promise.all(stages.map(async stage => {
    requireText(stage.id, `chain stage.id in ${chain.id}`);
    uniqueId(stage.id, `chain-stage:${chain.id}`);
    if (stageIds.has(stage.id)) throw new Error(`Duplicate chain stage in ${chain.id}: ${stage.id}`);
    stageIds.add(stage.id);
    requireText(stage.label, `chain stage.label in ${chain.id}`);
    requireText(stage.summary, `chain stage.summary in ${chain.id}`);
    if (stage.kind != null) requireText(stage.kind, `chain stage.kind in ${chain.id}/${stage.id}`);
    if (!chainStatuses.has(stage.status)) throw new Error(`Invalid chain stage status in ${chain.id}/${stage.id}: ${stage.status}`);
    const stageModules = requireList(stage.modules || [], `chain stage.modules in ${chain.id}/${stage.id}`);
    for (const id of stageModules) if (!moduleIds.has(id)) throw new Error(`Unknown module in chain stage ${chain.id}/${stage.id}: ${id}`);
    const sources = await Promise.all(requireList(stage.sources || [], `chain stage.sources in ${chain.id}/${stage.id}`).map(evidence));
    if (['covered', 'partial'].includes(stage.status) && !sources.length) throw new Error(`Chain stage ${chain.id}/${stage.id} requires evidence`);
    if (stage.status === 'unknown' && !stage.nextCheck) throw new Error(`Unknown chain stage ${chain.id}/${stage.id} must provide nextCheck`);
    return { id: stage.id, kind: stage.kind || 'custom', label: stage.label, status: stage.status, summary: stage.summary, nextCheck: stage.nextCheck || '', modules: stageModules, ...freshnessFields(stage), sources };
  }));
  const sources = await Promise.all(requireList(chain.sources, `chain.sources in ${chain.id}`).map(evidence));
  if (!sources.length) throw new Error(`No evidence for chain ${chain.id}`);
  return { id: chain.id, title: chain.title, kind: chain.kind || '业务链路', summary: chain.summary, trigger: chain.trigger, outcome: chain.outcome, modules: related, views: chainViews, stages: normalizedStages, ...freshnessFields(chain), sources };
}));
for (const chain of chains) {
  let readingView = views.find(view => ['sequence', 'narrative'].includes(view.kind) && chain.views.includes(view.id));
  if (!readingView) {
    let id = `chain_${chain.id.slice(0, 56)}`;
    while (viewIds.has(id)) id = `${id.slice(0, 63)}_`;
    viewIds.add(id);
    readingView = { id, title: chain.title, subtitle: chain.summary, group: '业务流程', icon: 'list-ordered', kind: 'narrative', tags: [], modules: chain.modules, notes: [], sources: [] };
    views.push(readingView);
  }
  chain.readingView = readingView.id;
  if (!chain.views.includes(readingView.id)) chain.views.push(readingView.id);
  for (const view of views.filter(view => ['sequence', 'narrative'].includes(view.kind) && chain.views.includes(view.id))) {
    view.chainIds ||= [];
    view.chainIds.push(chain.id);
  }
}
if (!views.length && !chains.length) throw new Error('At least one view or business chain is required');
// A legacy sequence view can use existing notes when no chain is available.
// Surface the evidence gap; do not invent a narrative by translating arrows.
const incompleteNarratives = views.filter(view => ['sequence', 'narrative'].includes(view.kind) && !view.chainIds?.length && !view.notes.length);
const evidenceRows = async (rows, kind) => Promise.all(requireList(rows || [], kind).map(async row => {
  const identity = kind === 'routes' ? row.prefix : row.name;
  requireText(identity, `${kind} identifier`);
  if (identifiers.has(kind + ':' + identity)) throw new Error(`Duplicate ${kind} entry: ${identity}`);
  identifiers.add(kind + ':' + identity);
  const sources = await Promise.all(requireList(row.sources, `${kind}.sources`).map(evidence));
  if (!sources.length) throw new Error(`No evidence for ${identity}`);
  return { ...row, sources };
}));
const tables = await evidenceRows(manifest.tables, 'tables');
for (const table of tables) {
  requireText(table.title, 'object.title'); requireText(table.kind, 'object.kind'); requireText(table.description, 'object.description');
}
const routes = await evidenceRows(manifest.routes, 'routes');
for (const route of routes) {
  requireText(route.name, 'route.name'); requireText(route.description, 'route.description');
  if (route.kind != null) requireText(route.kind, 'route.kind');
}
const flags = await evidenceRows(manifest.flags, 'flags');
for (const flag of flags) {
  if (!Object.hasOwn(flag, 'value')) throw new Error(`Missing flags.value for ${flag.name}`);
  requireText(flag.description, 'flag.description');
}
const findingKinds = new Set(['fact', 'risk', 'gap', 'decision']);
const findingStatuses = new Set(['confirmed', 'inferred', 'unverified']);
const findings = await Promise.all(requireList(manifest.findings || [], 'findings').map(async finding => {
  uniqueId(finding.id, 'finding');
  requireText(finding.title, 'finding.title');
  requireText(finding.summary, 'finding.summary');
  if (!findingKinds.has(finding.kind)) throw new Error(`Invalid finding kind in ${finding.id}: ${finding.kind}`);
  if (!findingStatuses.has(finding.status)) throw new Error(`Invalid finding status in ${finding.id}: ${finding.status}`);
  const related = requireList(finding.modules || [], `finding.modules in ${finding.id}`);
  for (const id of related) if (!moduleIds.has(id)) throw new Error(`Unknown module in finding ${finding.id}: ${id}`);
  const sources = await Promise.all(requireList(finding.sources, `finding.sources in ${finding.id}`).map(evidence));
  if (!sources.length) throw new Error(`No evidence for finding ${finding.id}`);
  if (finding.status === 'unverified' && !finding.nextCheck) throw new Error(`Unverified finding ${finding.id} must provide nextCheck`);
  return { id: finding.id, title: finding.title, kind: finding.kind, status: finding.status, summary: finding.summary, impact: finding.impact || '', nextCheck: finding.nextCheck || '', modules: related, ...freshnessFields(finding), sources };
}));
const coverageStatuses = new Set(['covered', 'partial', 'unknown', 'not_applicable']);
const coverage = await Promise.all(requireList(manifest.coverage || [], 'coverage').map(async item => {
  uniqueId(item.id, 'coverage');
  requireText(item.area, 'coverage.area');
  requireText(item.summary, 'coverage.summary');
  if (!coverageStatuses.has(item.status)) throw new Error(`Invalid coverage status in ${item.id}: ${item.status}`);
  const related = requireList(item.modules || [], `coverage.modules in ${item.id}`);
  for (const id of related) if (!moduleIds.has(id)) throw new Error(`Unknown module in coverage ${item.id}: ${id}`);
  const sources = await Promise.all(requireList(item.sources || [], `coverage.sources in ${item.id}`).map(evidence));
  if (['covered', 'partial'].includes(item.status) && !sources.length) throw new Error(`Coverage ${item.id} requires evidence for status ${item.status}`);
  if (item.status === 'unknown' && !item.nextCheck) throw new Error(`Unknown coverage ${item.id} must provide nextCheck`);
  return { id: item.id, area: item.area, status: item.status, summary: item.summary, nextCheck: item.nextCheck || '', modules: related, ...freshnessFields(item), sources };
}));
const files = [];
const listed = new Set();
const scanGroups = [];
for (const group of requireList(manifest.fileGroups || [], 'fileGroups')) {
  requireText(group.name, 'fileGroup.name');
  const extensions = requireList(group.extensions, 'fileGroup.extensions');
  if (!extensions.length || extensions.some(extension => typeof extension !== 'string' || !extension.startsWith('.'))) throw new Error('fileGroup.extensions must contain explicit file extensions');
  const excludes = new Set(['.git', '.repo-atlas', 'node_modules', '.venv', '__pycache__', ...requireList(group.exclude || [], `fileGroup.exclude in ${group.name}`)]);
  const visited = new Set();
  let found = 0;
  async function visit(path) {
    let full;
    try { full = await checkedPath(path); }
    catch (error) { if (reviewMode && ['ENOENT', 'ENOTDIR'].includes(error.code)) return; throw error; }
    if (visited.has(full)) return;
    visited.add(full);
    const info = await stat(full);
    if (info.isDirectory()) {
      for (const entry of await readdir(full, { withFileTypes: true })) {
        if (excludes.has(entry.name) || entry.isSymbolicLink()) continue;
        await visit(path.replace(/\/$/, '') + '/' + entry.name);
      }
    } else if (info.isFile() && extensions.includes(extname(path).toLowerCase())) {
      if (listed.has(full)) return;
      listed.add(full);
      protectedPaths.push(full);
      files.push({ path, name: path.split('/').pop(), group: group.name, line: 1, lines: await lineCount(full) });
      found++;
    }
  }
  for (const path of requireList(group.paths, 'fileGroup.paths')) await visit(path);
  scanGroups.push({ name: group.name, paths: group.paths, extensions, exclude: [...excludes], count: found });
}
files.sort((left, right) => left.path.localeCompare(right.path));
const repositories = [];
for (const repo of requireList(manifest.repositories || [], 'repositories')) {
  requireText(repo.path, 'repository.path');
  if (repo.name != null) requireText(repo.name, 'repository.name');
  const cwd = await checkedPath(repo.path);
  const git = args => execFileSync('git', ['--no-optional-locks', ...args], { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024 }).trim();
  repositories.push({ name: repo.name || repo.path, path: repo.path, commit: git(['rev-parse', '--short=8', 'HEAD']), branch: git(['branch', '--show-current']) || '(detached HEAD)', dirty: git(['status', '--short', '--untracked-files=no']).split(/\r?\n/).filter(Boolean) });
}
views.push({ id: 'catalog', title: '证据与覆盖索引', subtitle: '集中查看发现项、分析覆盖、对象、入口、配置和源码文件。', icon: 'list-tree', group: '证据', tags: ['可追溯索引'], modules: modules.map(module => module.id), notes: [['分析范围', project.scope], ['验证边界', project.boundary]], sources: [] });
// Sequence diagrams are retained as source evidence, but the report presents
// their linked chain stages as readable prose instead of rendering a dense
// Mermaid canvas.
const diagramViews = views.filter(view => view.diagram && !['sequence', 'narrative'].includes(view.kind));
const qualityWarnings = [];
for (const view of incompleteNarratives) qualityWarnings.push(`流程“${view.title}”缺少文字说明；请补充业务阶段或视图备注。`);
if (modules.length >= 8 && !chains.length) qualityWarnings.push('模块数量较多但没有登记业务链路；复杂项目容易退化为一张总览图。');
for (const chain of chains) {
  if (chain.stages[0]?.kind && !['entry', 'authorization', 'validation', 'custom'].includes(chain.stages[0].kind)) qualityWarnings.push(`“${chain.title}”从中间处理环节开始，阅读时还需要确认之前由谁发起、需要满足哪些条件。`);
  if (chain.stages.at(-1)?.kind && !['outcome', 'recovery', 'custom'].includes(chain.stages.at(-1).kind)) qualityWarnings.push(`“${chain.title}”的步骤尚未讲到最终结果或异常恢复，后续处理还需要补充确认。`);
  const linkedViews = chain.views.map(id => views.find(view => view.id === id)).filter(Boolean);
  const linkedModules = new Set(linkedViews.flatMap(view => view.modules));
  for (const moduleId of chain.modules) if (linkedViews.length && !linkedModules.has(moduleId)) qualityWarnings.push(`“${chain.title}”涉及的“${modules.find(module => module.id === moduleId)?.name || '相关环节'}”尚未出现在配套关系图中。`);
}
const quality = { level: qualityWarnings.length ? 'review' : 'ready', warnings: qualityWarnings };
if (unresolvedCount) { quality.level = 'review'; quality.warnings.push(`${unresolvedCount} 处证据未解析；此报告仅用于复核。`); }
function markUnresolved(row) {
  if (!row.sources.some(source => source.state === 'unresolved')) return;
  row.freshness = 'unresolved'; row.reviewRequired = true;
  if (['covered', 'partial', 'confirmed'].includes(row.status)) {
    row.declaredStatus = row.status;
    row.status = row.status === 'confirmed' ? 'unverified' : 'unknown';
  }
}
for (const [kind, rows, field] of [['module', modules, 'id'], ['view', views, 'id'], ['chain', chains, 'id'], ['finding', findings, 'id'], ['coverage', coverage, 'id'], ['table', tables, 'name'], ['route', routes, 'prefix'], ['flag', flags, 'name']]) {
  for (const row of rows) {
    row.sources.forEach((source, index) => { source.key = `${kind}:${row[field]}:${source.sourceId ?? index}`; });
    markUnresolved(row);
    if (kind === 'chain') for (const stage of row.stages) {
      stage.sources.forEach((source, index) => { source.key = `chain:${row.id}/${stage.id}:${source.sourceId ?? index}`; });
      markUnresolved(stage);
    }
  }
}
const evidenceCount = [
  ...modules, ...views, ...chains, ...chains.flatMap(chain => chain.stages), ...tables, ...routes, ...flags, ...findings, ...coverage
].reduce((sum, item) => sum + (item.sources?.length || 0), 0);
const data = {
  project: { title: project.title, subtitle: project.subtitle || 'REPOSITORY ATLAS', summary: project.summary || '', scope: project.scope, boundary: project.boundary },
  date: new Date().toISOString().slice(0, 10),
  reviewMode, unresolvedCount, review: manifest.review || null,
  renderer: 'Mermaid 10.9.3', modules, views, chains, findings, coverage, tables, routes, flags, files, repositories, scanGroups, quality,
  update: manifest.update && typeof manifest.update === 'object' ? {
    mode: manifest.update.mode || 'incremental-candidate',
    generatedAt: manifest.update.generatedAt || null,
    baseSnapshot: manifest.update.baseSnapshot || null,
    deltaPath: manifest.update.deltaPath || null,
    summary: manifest.update.summary || null,
    impacted: Array.isArray(manifest.update.impacted) ? manifest.update.impacted : [],
    staleEvidence: Array.isArray(manifest.update.staleEvidence) ? manifest.update.staleEvidence : [],
    unmappedChanges: Array.isArray(manifest.update.unmappedChanges) ? manifest.update.unmappedChanges : [],
    reviewRequired: Boolean(manifest.update.reviewRequired)
  } : null,
  sourceBase: (slash(relative(dirname(output), workspace)) || '.') + '/',
  stats: {
    modules: modules.length, chains: chains.length, findings: findings.length, coverage: coverage.length, evidence: evidenceCount,
    tables: tables.length, files: files.length, routes: routes.length, diagrams: diagramViews.length
  },
  extraLinks: []
};
const assets = resolve(here, '../assets/report');
const [template, css, app, mermaid, icons] = await Promise.all(['template.html', 'style.css', 'app.js', 'vendor/mermaid-10.9.3.min.js', 'vendor/lucide-0.468.0.min.js'].map(path => readFile(resolve(assets, path), 'utf8')));
const safeScript = value => value.replace(/<\/script/gi, '<\\/script');
const replacements = {
  '/* INLINE_STYLE */': css,
  '/* INLINE_MERMAID */': safeScript(mermaid),
  '/* INLINE_ICONS */': safeScript(icons),
  '/* INLINE_APP */': safeScript(app),
  DATA_JSON: JSON.stringify(redactValue(data, secrets)).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026')
};
const html = template.replace(/\/\* INLINE_(?:STYLE|MERMAID|ICONS|APP) \*\/|DATA_JSON/g, match => replacements[match]);
await atomicWrite(workspace, output, html, { extension: '.html', replace, protectedPaths });
console.log(JSON.stringify({ output, bytes: Buffer.byteLength(html), ...data.stats, repositories: repositories.map(repo => ({ name: repo.name, commit: repo.commit })) }, null, 2));
