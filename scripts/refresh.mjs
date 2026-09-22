import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadManifest, parseOptions, assertOutputInside, writeJson } from './snapshot-lib.mjs';

const options = parseOptions(process.argv.slice(2));
const manifestArg = options._[0];
if (!manifestArg || options.help) {
  console.error('Usage: node refresh.mjs <atlas.json> --delta .repo-atlas/delta.json [--output atlas.next.json]');
  process.exit(options.help ? 0 : 2);
}
const bundle = await loadManifest(manifestArg);
const deltaPath = assertOutputInside(bundle.workspace, options.delta || '.repo-atlas/delta.json');
const delta = JSON.parse(await readFile(deltaPath, 'utf8'));
const output = assertOutputInside(bundle.workspace, options.output || `${manifestArg.replace(/\.json$/i, '')}.next.json`);
const staleEntities = new Set((delta.staleEvidence || []).map(item => item.entity));
const impactedModules = new Set((delta.impacted || []).filter(value => value.startsWith('module:')).map(value => value.slice('module:'.length)));
const fullReview = Boolean(delta.summary?.fullReanalysisRecommended || delta.summary?.manifestChanged);
const clearFreshness = row => {
  const { freshness, reviewRequired, staleReason, ...base } = row;
  return base;
};
const mark = (row, entity) => {
  const stale = fullReview || staleEntities.has(entity) || (row.modules || []).some(module => impactedModules.has(module));
  if (!stale) return row;
  return { ...row, freshness: 'stale', reviewRequired: true, staleReason: fullReview ? '分析清单或公共基础设施在快照后发生变化' : staleEntities.has(entity) ? '源码证据在快照后发生变化' : '关联模块在快照后发生变化' };
};
const next = structuredClone(bundle.manifest);
next.update = {
  mode: 'incremental-candidate',
  generatedAt: new Date().toISOString(),
  baseSnapshot: delta.from?.path || '.repo-atlas/snapshot.json',
  deltaPath: options.delta || '.repo-atlas/delta.json',
  summary: delta.summary,
  impacted: delta.impacted || [],
  staleEvidence: delta.staleEvidence || [],
  reviewRequired: Boolean(delta.summary?.staleEvidence || delta.summary?.fullReanalysisRecommended || delta.summary?.manifestChanged)
};
next.modules = (next.modules || []).map(row => mark(clearFreshness(row), `module:${row.id}`));
next.views = (next.views || []).map(row => mark(clearFreshness(row), `view:${row.id}`));
next.chains = (next.chains || []).map(row => mark(clearFreshness(row), `chain:${row.id}`));
next.findings = (next.findings || []).map(row => mark(clearFreshness(row), `finding:${row.id}`));
next.coverage = (next.coverage || []).map(row => mark(clearFreshness(row), `coverage:${row.id}`));
next.tables = (next.tables || []).map(row => mark(clearFreshness(row), `table:${row.name}`));
next.routes = (next.routes || []).map(row => mark(clearFreshness(row), `route:${row.prefix}`));
next.flags = (next.flags || []).map(row => mark(clearFreshness(row), `flag:${row.name}`));
await mkdir(dirname(output), { recursive: true });
await writeFile(output, writeJson(next), { encoding: 'utf8', flag: 'w' });
console.log(JSON.stringify({ output, mode: next.update.mode, ...delta.summary }, null, 2));
