import { readFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { loadManifest, parseOptions, assertOutputInside, writeJson, validateDelta, protectedSourcePaths, slash } from './snapshot-lib.mjs';
import { planOutput, atomicWrite } from './io-lib.mjs';
import { relocateSchema } from './manifest-lib.mjs';

const options = parseOptions(process.argv.slice(2), {"value":["delta","from","output"],"usage":"Usage: node scripts/refresh.mjs <atlas.json> [--delta delta.json] [--from snapshot.json] [--output atlas.next.json]"});
const manifestArg = options._[0];
const bundle = await loadManifest(manifestArg);
const deltaPath = assertOutputInside(bundle.workspace, options.delta || '.repo-atlas/delta.json');
const delta = JSON.parse(await readFile(deltaPath, 'utf8'));
const baselinePath = assertOutputInside(bundle.workspace, options.from || delta.from?.path || '.repo-atlas/snapshot.json');
const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
const current = await validateDelta(bundle, baseline, delta);
const protectedPaths = [...protectedSourcePaths(bundle, { ...baseline.files, ...current.files }), deltaPath, baselinePath];
const output = planOutput(bundle.workspace, options.output || `${bundle.manifestPath.replace(/\.json$/i, '')}.next.json`, { protectedPaths });
const staleEntities = new Set((delta.staleEvidence || []).map(item => item.entity));
const impacted = new Set(delta.impacted || []);
const impactedModules = new Set((delta.impacted || []).filter(value => value.startsWith('module:')).map(value => value.slice('module:'.length)));
const fullReview = Boolean(delta.summary?.fullReanalysisRecommended || delta.summary?.manifestChanged);
const mark = (row, entity) => {
  const stale = fullReview || impacted.has(entity) || staleEntities.has(entity) || (row.modules || []).some(module => impactedModules.has(module));
  if (!stale) return row;
  return { ...row, freshness: 'stale', reviewRequired: true, staleReason: fullReview ? '分析清单或公共基础设施在快照后发生变化' : staleEntities.has(entity) ? '源码证据在快照后发生变化' : '关联模块在快照后发生变化' };
};
const next = structuredClone(bundle.manifest);
relocateSchema(next, bundle.manifestPath, output);
next.workspace = slash(relative(dirname(output), bundle.workspace) || '.');
const mergeQueue = (previous, current, key) => [...new Map([...(previous || []), ...(current || [])].map(item => [item[key], item])).values()];
next.update = {
  mode: 'incremental-candidate',
  generatedAt: new Date().toISOString(),
  baseSnapshot: delta.from?.path || '.repo-atlas/snapshot.json',
  deltaPath: options.delta || '.repo-atlas/delta.json',
  summary: delta.summary,
  impacted: [...new Set([...(bundle.manifest.update?.impacted || []), ...(delta.impacted || [])])],
  staleEvidence: mergeQueue(bundle.manifest.update?.staleEvidence, delta.staleEvidence, 'key'),
  unmappedChanges: mergeQueue(bundle.manifest.update?.unmappedChanges, delta.unmappedChanges, 'path'),
  reviewRequired: Boolean(delta.summary?.reviewRequired || bundle.manifest.update?.reviewRequired)
};
next.modules = (next.modules || []).map(row => mark(row, `module:${row.id}`));
next.views = (next.views || []).map(row => mark(row, `view:${row.id}`));
next.chains = (next.chains || []).map(row => {
  const chain = mark(row, `chain:${row.id}`);
  chain.stages = (row.stages || []).map(stage => mark(stage, `chain-stage:${row.id}/${stage.id}`));
  return chain.stages.some(stage => stage.reviewRequired) ? { ...chain, reviewRequired: true } : chain;
});
next.findings = (next.findings || []).map(row => mark(row, `finding:${row.id}`));
next.coverage = (next.coverage || []).map(row => mark(row, `coverage:${row.id}`));
next.tables = (next.tables || []).map(row => mark(row, `table:${row.name}`));
next.routes = (next.routes || []).map(row => mark(row, `route:${row.prefix}`));
next.flags = (next.flags || []).map(row => mark(row, `flag:${row.name}`));
if ([...next.modules, ...next.views, ...next.chains, ...next.findings, ...next.coverage, ...next.tables, ...next.routes, ...next.flags].some(row => row.reviewRequired)) next.update.reviewRequired = true;
if (next.update.unmappedChanges.length || next.update.staleEvidence.length) next.update.reviewRequired = true;
await atomicWrite(bundle.workspace, output, writeJson(next), { protectedPaths });
console.log(JSON.stringify({ output, mode: next.update.mode, ...delta.summary }, null, 2));
