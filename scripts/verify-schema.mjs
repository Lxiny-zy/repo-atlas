// Optional independent comparison against Ajv's draft 2020-12 implementation.
// Ajv is a test dependency supplied by the caller, never a runtime dependency.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { manifestSchema, validateSchema } from './schema-lib.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--ajv') {
  console.error('Usage: node scripts/verify-schema.mjs --ajv <ajv/dist/2020.js>');
  process.exit(2);
}
const { default: Ajv } = await import(pathToFileURL(resolve(args[1])).href);
const ajv = new Ajv({ strict: false, allErrors: true });
assert.equal(ajv.validateSchema(manifestSchema), true, JSON.stringify(ajv.errors));
const standard = ajv.compile(manifestSchema);
const base = JSON.parse(await readFile(new URL('../tests/fixtures/multi-chain/atlas.json', import.meta.url), 'utf8'));
const source = base.modules[0].sources[0];
base.$schema = '../../schemas/atlas.schema.json';
base.project.subtitle = 'Subtitle'; base.project.summary = 'Summary';
Object.assign(base.modules[0], { paths: ['src'], category: 'Core', icon: 'box', freshness: 'stale', reviewRequired: true, staleReason: 'Changed' });
Object.assign(base.modules[0].sources[0], { id: 'main', occurrence: 1, redact: ['secret'] });
Object.assign(base.views[0], { notes: [['Title', 'Text']], tags: ['tag'], aliases: { short: 'long' }, legend: [{ label: 'Core', color: '#00ff00' }], useDefaultClasses: true, mobileDiagram: 'flowchart TB\na --> b' });
base.views.push({ id: 'reading', kind: 'narrative', title: 'Read', modules: [], sources: [] });
base.findings[0].status = 'unverified'; base.findings[0].nextCheck = 'Check it'; base.findings[0].impact = 'Impact';
base.coverage = ['covered', 'partial', 'unknown', 'not_applicable'].map(status => ({ id: status, area: 'Area', summary: 'Scope', status, nextCheck: 'Check', sources: [source] }));
base.tables = [{ name: 'orders', title: 'Orders', kind: 'File', description: 'Object', sources: [source] }];
base.routes = [{ prefix: 'GET /orders', name: 'Orders', kind: 'HTTP', description: 'Route', sources: [source] }];
base.flags = [{ name: 'enabled', value: true, description: 'Flag', sources: [source] }];
base.repositories = [{ name: 'Repo', path: '.' }]; base.fileGroups[0].exclude = ['vendor'];
base.update = { reviewRequired: true }; base.review = { reviewer: 'Fixture' };
let count = 0;
const compare = (value, label) => {
  const actual = !validateSchema(value).length;
  assert.equal(actual, standard(value), `${label}: ${JSON.stringify(standard.errors)}`);
  count++;
};
compare(base, 'complete manifest');
const locations = [];
function walk(value, path = []) {
  locations.push(path);
  if (value && typeof value === 'object') for (const key of Object.keys(value)) walk(value[key], [...path, key]);
}
walk(base);
for (const path of locations) {
  for (const value of [null, [], {}, 0, 1, 61, true, false, '', ' ', 'custom', 'catalog', '../escape', 'C:/outside', 'a\\b', 'a'.repeat(65), '😀', { unexpected: true }]) {
    const candidate = structuredClone(base);
    if (!path.length) { compare(value, 'root'); continue; }
    let parent = candidate;
    for (const key of path.slice(0, -1)) parent = parent[key];
    parent[path.at(-1)] = value;
    compare(candidate, path.join('/'));
  }
  if (path.length) {
    const candidate = structuredClone(base); let parent = candidate;
    for (const key of path.slice(0, -1)) parent = parent[key];
    delete parent[path.at(-1)];
    // Sparse arrays are not JSON values; deletion only models object fields.
    if (!Array.isArray(parent)) compare(candidate, `delete ${path.join('/')}`);
  }
}
console.log(JSON.stringify({ valid: true, dialect: '2020-12', comparisons: count, schemaValid: true }, null, 2));
