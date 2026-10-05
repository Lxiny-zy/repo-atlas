import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hashText, writeJson } from './snapshot-lib.mjs';
import { assertManifest } from './manifest-lib.mjs';
import { parseOptions } from './cli-lib.mjs';
import { planOutput, atomicWrite } from './io-lib.mjs';

const options = parseOptions(process.argv.slice(2), {
  boolean: ['json', 'replace'], value: ['output'], min: 2,
  usage: 'Usage: node scripts/compare.mjs <base-atlas.json> <head-atlas.json> [--output diff.json] [--json] [--replace]'
});

const collections = [
  ['modules', 'id'], ['views', 'id'], ['chains', 'id'], ['findings', 'id'],
  ['coverage', 'id'], ['tables', 'name'], ['routes', 'prefix'], ['flags', 'name']
];
const runtimeFields = new Set(['freshness', 'reviewRequired', 'staleReason']);
const clone = value => {
  if (Array.isArray(value)) return value.map(clone);
  if (!value || typeof value !== 'object') return value;
  const result = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    result[key] = clone(value[key]);
  }
  return result;
};
// Metadata is excluded only at schema-defined entity boundaries. Arbitrary
// JSON inside flag values must retain every key, including metadata-like names.
const semanticRow = (row, collection) => {
  const result = clone(row);
  for (const field of runtimeFields) delete result[field];
  if (collection === 'chains') result.stages = (result.stages || []).map(stage => semanticRow(stage, 'stages'));
  return result;
};
const indexCollection = (manifest, collection, key) => new Map((manifest[collection] || []).map((row, index) => [String(row?.[key] ?? index), { row, index }]));
const changedFields = (before, after) => {
  const fields = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const result = [];
  for (const field of [...fields].sort()) {
    const left = before?.[field]; const right = after?.[field];
    if (JSON.stringify(left) !== JSON.stringify(right)) result.push({ path: `/${field}`, before: left ?? null, after: right ?? null });
  }
  return result;
};

const basePath = resolve(options._[0]); const headPath = resolve(options._[1]);
const outputRoot = await realpath(process.cwd());
const outputOptions = { protectedPaths: [basePath, headPath], replace: Boolean(options.replace) };
const outputPath = options.output ? planOutput(outputRoot, options.output, outputOptions) : null;
const base = JSON.parse((await readFile(basePath, 'utf8')).replace(/^\uFEFF/, ''));
const head = JSON.parse((await readFile(headPath, 'utf8')).replace(/^\uFEFF/, ''));
assertManifest(base); assertManifest(head);
const result = {
  schemaVersion: 1,
  purpose: 'repo-atlas-semantic-diff',
  base: { path: basePath, sha256: hashText(JSON.stringify(base)) },
  head: { path: headPath, sha256: hashText(JSON.stringify(head)) },
  root: { changed: changedFields({ project: clone(base.project), fileGroups: clone(base.fileGroups), repositories: clone(base.repositories) }, { project: clone(head.project), fileGroups: clone(head.fileGroups), repositories: clone(head.repositories) }) },
  collections: {},
  changes: []
};
const compareCollection = (collection, key, beforeRows, afterRows) => {
  const before = indexCollection({ [collection]: beforeRows }, collection, key); const after = indexCollection({ [collection]: afterRows }, collection, key);
  const added = []; const removed = []; const changed = [];
  for (const [id, entry] of after) if (!before.has(id)) added.push({ key: id, value: semanticRow(entry.row, collection) });
  for (const [id, entry] of before) if (!after.has(id)) removed.push({ key: id, value: semanticRow(entry.row, collection) });
  for (const [id, entry] of after) {
    if (!before.has(id)) continue;
    const left = semanticRow(before.get(id).row, collection); const right = semanticRow(entry.row, collection);
    const fields = changedFields(left, right);
    if (fields.length) changed.push({ key: id, fields, before: left, after: right });
  }
  result.collections[collection] = { added, removed, changed, unchanged: before.size - removed.length - changed.length };
  for (const item of added) result.changes.push({ collection, key: item.key, status: 'added' });
  for (const item of removed) result.changes.push({ collection, key: item.key, status: 'removed' });
  for (const item of changed) result.changes.push({ collection, key: item.key, status: 'changed', fields: item.fields.map(field => field.path) });
};
for (const [collection, key] of collections) compareCollection(collection, key, base[collection] || [], head[collection] || []);
const stages = manifest => (manifest.chains || []).flatMap(chain => (chain.stages || []).map(stage => ({ ...stage, id: `${chain.id}/${stage.id}` })));
compareCollection('stages', 'id', stages(base), stages(head));
result.summary = {
  added: result.changes.filter(item => item.status === 'added').length,
  removed: result.changes.filter(item => item.status === 'removed').length,
  changed: result.changes.filter(item => item.status === 'changed').length,
  collections: collections.length + 1,
  rootChanged: result.root.changed.length > 0
};
const output = writeJson(result);
if (outputPath) await atomicWrite(outputRoot, outputPath, output, outputOptions);
if (options.json || !options.output) console.log(output);
