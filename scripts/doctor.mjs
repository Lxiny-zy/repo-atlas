import { readFile, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { parseOptions } from './cli-lib.mjs';
import { validateManifestFile, manifestRows } from './manifest-lib.mjs';
import { gitInfo } from './git-lib.mjs';

const options = parseOptions(process.argv.slice(2), {
  boolean: ['json', 'strict'], usage: 'Usage: node scripts/doctor.mjs <atlas.json> [--json] [--strict]'
});
const file = resolve(options._[0]);
const validation = await validateManifestFile(file);
const warnings = [];
let manifest;
try { manifest = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')); } catch {}
if (manifest && typeof manifest === 'object') {
  for (const { row, path, collection } of manifestRows(manifest)) {
    if (Array.isArray(row.sources) && row.sources.some(source => source && !source.id)) warnings.push({ code: 'evidence.unstableIdentity', path: `${path}/sources`, message: '为证据分配稳定 id，可用 migrate 命令。' });
    if (row.facts?.length && !row.evidenceBindings?.length) warnings.push({ code: 'evidence.coarseBinding', path, message: '实体包含事实，建议用 evidenceBindings 绑定具体字段。' });
    if (collection === 'chains' && !row.transitions?.length) warnings.push({ code: 'process.unstructured', path, message: '阶段顺序仅供阅读；需要机器核对分支时填写 transitions。' });
    if (row.status === 'unknown' || row.status === 'partial' || row.status === 'unverified') warnings.push({ code: 'analysis.incomplete', path, message: '该项仍有待核对内容。' });
  }
  if (!manifest.fileGroups?.length) warnings.push({ code: 'inventory.evidenceOnly', path: '/fileGroups', message: '未声明扫描范围；未引用的新文件不会进入增量检测。' });
}
let git = { available: false };
if (typeof manifest?.workspace === 'string') {
  try { git = gitInfo(await realpath(resolve(dirname(file), manifest.workspace))); } catch {}
}
const result = { purpose: 'repo-atlas-doctor', readOnly: true, valid: validation.valid, runtime: { node: process.version, supported: Number(process.versions.node.split('.')[0]) >= 18 }, git, checks: validation.checks, diagnostics: validation.diagnostics, warnings };
if (options.json) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`${result.valid ? 'VALID' : 'INVALID'}; ${result.diagnostics.length} diagnostics; ${warnings.length} authoring warnings; Node ${process.version}; Git ${git.available ? 'available' : 'unavailable'}`);
  for (const item of [...result.diagnostics, ...warnings]) console.log(`${item.path || '/'} [${item.code}] ${item.message}`);
}
process.exitCode = !result.valid || !result.runtime.supported || (options.strict && warnings.length) ? 1 : 0;
