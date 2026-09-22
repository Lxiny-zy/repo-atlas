import { readFile, readdir, writeFile, realpath, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const input = process.argv[2];
const replace = process.argv.includes('--replace');
if (!input || input.startsWith('--')) {
  console.error('Usage: node build.mjs <atlas.json> [--replace]');
  process.exit(2);
}
const manifestPath = resolve(input);
const manifest = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''));
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
const output = resolve(workspace, requireText(manifest.output, 'output'));
if (!inside(workspace, output) || extname(output).toLowerCase() !== '.html') throw new Error('output must be an HTML file within workspace');
// Check existing ancestors before mkdir/write so a symlink cannot redirect output.
let ancestor = dirname(output);
for (;;) {
  try {
    if (!inside(workspace, await realpath(ancestor))) throw new Error('output ancestor escapes workspace');
    break;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    ancestor = dirname(ancestor);
  }
}
try {
  const existing = await realpath(output);
  if (!inside(workspace, existing)) throw new Error('output escapes workspace');
  if (!replace) throw new Error('Output already exists. Use --replace only when updating this report is authorized.');
} catch (error) { if (error.code !== 'ENOENT') throw error; }

async function checkedPath(value) {
  requireText(value, 'source path');
  if (isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.includes('\\')) throw new Error(`Use a workspace-relative path with /: ${value}`);
  const full = await realpath(resolve(workspace, value));
  if (!inside(workspace, full)) throw new Error(`Source escapes workspace: ${value}`);
  return full;
}
const cache = new Map();
async function read(path) {
  if (!cache.has(path)) cache.set(path, await readFile(await checkedPath(path), 'utf8'));
  return cache.get(path);
}
async function evidence(spec) {
  const lines = (await read(requireText(spec.path, 'source.path'))).split(/\r?\n/);
  const needle = requireText(spec.match, `source.match in ${spec.path}`);
  const matches = lines.flatMap((line, index) => line.includes(needle) ? [index] : []);
  if (!matches.length) throw new Error(`Missing evidence anchor: ${spec.path} :: ${needle}`);
  if (matches.length > 1 && spec.occurrence == null) throw new Error(`Ambiguous evidence anchor (${matches.length} matches): ${spec.path} :: ${needle}. Set occurrence or use a unique anchor.`);
  const occurrence = spec.occurrence ?? 1;
  if (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > matches.length) throw new Error(`Invalid evidence occurrence: ${spec.path}`);
  const count = spec.length ?? 8;
  if (!Number.isInteger(count) || count < 1 || count > 60) throw new Error('Evidence length must be 1..60 lines');
  const start = matches[occurrence - 1];
  let excerpt = lines.slice(start, start + count).join('\n');
  for (const secret of spec.redact || []) excerpt = excerpt.split(requireText(secret, 'redact value')).join('[已隐去]');
  return { path: spec.path, line: start + 1, excerpt };
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
const views = await Promise.all(requireList(manifest.views, 'views').map(async view => {
  uniqueId(view.id, 'view');
  if (view.id === 'catalog') throw new Error('catalog is reserved for the generated index');
  requireText(view.title, 'view.title');
  requireText(view.diagram, 'view.diagram');
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
    tags, diagram: theme(view.diagram), mobileDiagram: view.mobileDiagram ? theme(view.mobileDiagram) : undefined,
    modules: view.modules, notes, aliases: Object.keys(aliases).length ? aliases : undefined, legend: legend.length ? legend : undefined, ...freshnessFields(view),
    sources: await Promise.all(requireList(view.sources || [], `view.sources in ${view.id}`).map(evidence))
  };
}));
if (!views.length) throw new Error('At least one diagram is required');
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
  const chainViews = requireList(chain.views || [], `chain.views in ${chain.id}`);
  for (const id of chainViews) if (!viewIds.has(id)) throw new Error(`Unknown view in chain ${chain.id}: ${id}`);
  const stages = requireList(chain.stages, `chain.stages in ${chain.id}`);
  if (stages.length < 3) throw new Error(`Chain ${chain.id} must contain at least 3 stages`);
  const stageIds = new Set();
  const normalizedStages = await Promise.all(stages.map(async stage => {
    requireText(stage.id, `chain stage.id in ${chain.id}`);
    uniqueId(`${chain.id}__${stage.id}`, 'chain-stage');
    if (stageIds.has(stage.id)) throw new Error(`Duplicate chain stage in ${chain.id}: ${stage.id}`);
    stageIds.add(stage.id);
    requireText(stage.label, `chain stage.label in ${chain.id}`);
    requireText(stage.summary, `chain stage.summary in ${chain.id}`);
    if (!chainStatuses.has(stage.status)) throw new Error(`Invalid chain stage status in ${chain.id}/${stage.id}: ${stage.status}`);
    const stageModules = requireList(stage.modules || [], `chain stage.modules in ${chain.id}/${stage.id}`);
    for (const id of stageModules) if (!moduleIds.has(id)) throw new Error(`Unknown module in chain stage ${chain.id}/${stage.id}: ${id}`);
    const sources = await Promise.all(requireList(stage.sources || [], `chain stage.sources in ${chain.id}/${stage.id}`).map(evidence));
    if (['covered', 'partial'].includes(stage.status) && !sources.length) throw new Error(`Chain stage ${chain.id}/${stage.id} requires evidence`);
    if (stage.status === 'unknown' && !stage.nextCheck) throw new Error(`Unknown chain stage ${chain.id}/${stage.id} must provide nextCheck`);
    return { id: stage.id, label: stage.label, status: stage.status, summary: stage.summary, nextCheck: stage.nextCheck || '', modules: stageModules, sources };
  }));
  const sources = await Promise.all(requireList(chain.sources, `chain.sources in ${chain.id}`).map(evidence));
  if (!sources.length) throw new Error(`No evidence for chain ${chain.id}`);
  return { id: chain.id, title: chain.title, kind: chain.kind || '业务链路', summary: chain.summary, trigger: chain.trigger, outcome: chain.outcome, modules: related, views: chainViews, stages: normalizedStages, ...freshnessFields(chain), sources };
}));
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
    const full = await checkedPath(path);
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
      const lines = (await read(path)).split(/\r?\n/);
      files.push({ path, name: path.split('/').pop(), group: group.name, line: 1, lines: lines.length });
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
const diagramViews = views.filter(view => view.diagram);
const qualityWarnings = [];
if (modules.length >= 8 && !chains.length) qualityWarnings.push('模块数量较多但没有登记业务链路；复杂项目容易退化为一张总览图。');
if (modules.length >= 8 && diagramViews.length < 3) qualityWarnings.push('复杂范围只有少量关系图；建议补充专属时序、状态、数据或失败恢复视图。');
for (const chain of chains) if (!chain.views.length) qualityWarnings.push(`链路“${chain.title}”没有关联关系图，阶段证据无法通过视图复核。`);
const quality = { level: qualityWarnings.length ? 'review' : 'ready', warnings: qualityWarnings };
const evidenceCount = [
  ...modules, ...views, ...chains, ...chains.flatMap(chain => chain.stages), ...tables, ...routes, ...flags, ...findings, ...coverage
].reduce((sum, item) => sum + (item.sources?.length || 0), 0);
const data = {
  project: { title: project.title, subtitle: project.subtitle || 'REPOSITORY ATLAS', scope: project.scope, boundary: project.boundary },
  date: new Date().toISOString().slice(0, 10),
  renderer: 'Mermaid 10.9.3', modules, views, chains, findings, coverage, tables, routes, flags, files, repositories, scanGroups, quality,
  update: manifest.update && typeof manifest.update === 'object' ? {
    mode: manifest.update.mode || 'incremental-candidate',
    generatedAt: manifest.update.generatedAt || null,
    baseSnapshot: manifest.update.baseSnapshot || null,
    deltaPath: manifest.update.deltaPath || null,
    summary: manifest.update.summary || null,
    impacted: Array.isArray(manifest.update.impacted) ? manifest.update.impacted : [],
    staleEvidence: Array.isArray(manifest.update.staleEvidence) ? manifest.update.staleEvidence : [],
    reviewRequired: Boolean(manifest.update.reviewRequired)
  } : null,
  sourceBase: (slash(relative(dirname(output), workspace)) || '.') + '/',
  stats: {
    modules: modules.length, chains: chains.length, findings: findings.length, coverage: coverage.length, evidence: evidenceCount,
    tables: tables.length, files: files.length, routes: routes.length, diagrams: views.filter(view => view.diagram).length
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
  DATA_JSON: JSON.stringify(data).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026')
};
const html = template.replace(/\/\* INLINE_(?:STYLE|MERMAID|ICONS|APP) \*\/|DATA_JSON/g, match => replacements[match]);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, html, { encoding: 'utf8', flag: replace ? 'w' : 'wx' });
console.log(JSON.stringify({ output, bytes: Buffer.byteLength(html), ...data.stats, repositories: repositories.map(repo => ({ name: repo.name, commit: repo.commit })) }, null, 2));
