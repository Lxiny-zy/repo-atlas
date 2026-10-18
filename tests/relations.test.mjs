import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, appendFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateManifest } from '../scripts/manifest-lib.mjs';
import { collectSourceRows, analysisManifestHash } from '../scripts/snapshot-lib.mjs';
import { copyFixture } from '../scripts/fixture-lib.mjs';
import { relationVariants } from '../scripts/relation-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const original = JSON.parse(await readFile(resolve(root, 'tests/fixtures/multi-chain/atlas.json'), 'utf8'));
function manifest() {
  const input = structuredClone(original);
  input.relations = [
    { id: 'api_worker', from: 'api', to: 'worker', kind: 'dependency', label: 'Validates orders', summary: 'API depends on worker validation.', sources: structuredClone(input.modules[0].sources) },
    { id: 'audit_data', from: 'worker', to: 'audit', kind: 'data_flow', label: 'Order identifier', summary: 'Audit receives the order identifier.', payload: ['orderId'], sources: structuredClone(input.modules[2].sources) }
  ];
  input.views.push({ id: 'architecture', kind: 'overview', title: 'Architecture', modules: ['api', 'worker', 'audit'], relations: ['api_worker', 'audit_data'] });
  return input;
}
function run(dir, script, ...args) {
  const output = spawnSync(process.execPath, [resolve(root, 'scripts', script), ...args], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(output.status, 0, output.stderr || output.stdout);
  return output.stdout;
}
async function fixture(t, input) {
  const dir = await mkdtemp(resolve(tmpdir(), 'atlas-relations-'));
  t.after(async () => { assert.ok(dir.startsWith(resolve(tmpdir(), 'atlas-relations-'))); await rm(dir, { recursive: true, force: true }); });
  await copyFixture(dir);
  await writeFile(resolve(dir, 'atlas.json'), JSON.stringify(input));
  return dir;
}

test('relations and data fields validate references and preserve older manifests', () => {
  assert.deepEqual(validateManifest(original), []);
  const input = manifest();
  assert.deepEqual(validateManifest(input), []);
  input.relations[0].from = 'missing';
  input.views.at(-1).relations.push('missing');
  input.tables = [{ name: 'orders', title: 'Orders', kind: 'logical', description: 'Synthetic structure', sources: input.modules[0].sources, fields: [{ name: 'id', type: 'string', description: 'Identifier', references: { table: 'missing', field: 'id', kind: 'logical' } }] }];
  const errors = validateManifest(input);
  for (const path of ['/relations/0/from', '/views/2/relations/2', '/tables/0/fields/0/references/table']) assert.ok(errors.some(row => row.path === path), path);
  input.relations[1].id = input.relations[0].id;
  assert.ok(validateManifest(input).some(row => row.code === 'identity.duplicate' && row.path === '/relations/1/id'));
});

test('structured chain transitions validate, render and remain available to the report reader', async t => {
  const input = manifest();
  const chain = input.chains[0];
  chain.views.push('auto_flow');
  chain.transitions = [
    { id: 'validate_to_publish', from: 'validation', to: 'publish', label: 'Validation succeeds', guard: 'input is valid', effects: ['order status'], status: 'confirmed', sources: structuredClone(chain.stages[1].sources) }
  ];
  input.views.push({ id: 'auto_flow', title: 'Generated order flow', kind: 'flow', chain: chain.id, modules: chain.modules, sources: [] });
  assert.deepEqual(validateManifest(input), []);
  const dir = await fixture(t, input);
  run(dir, 'build.mjs', 'atlas.json');
  const html = await readFile(resolve(dir, 'report.html'), 'utf8');
  const data = JSON.parse(html.match(/<script id="graph-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  const built = data.chains.find(row => row.id === chain.id);
  assert.equal(built.transitions[0].guard, 'input is valid');
  assert.match(data.views.find(row => row.id === 'auto_flow').diagram, /validate_to_publish|Validation succeeds/);
});

test('reader diagrams show only declared data delivery and safely name Mermaid nodes', () => {
  const modules = [{ id: 'end', name: 'End "handler"' }, { id: 'graph', name: 'Graph <storage>' }];
  const rows = [{ id: 'dep', from: 'end', to: 'graph', kind: 'dependency', label: 'reads' }, { id: 'flow', from: 'graph', to: 'end', kind: 'data_flow', label: 'result' }];
  const built = relationVariants({ modules: ['end', 'graph'], relations: ['dep', 'flow'], kind: 'overview' }, modules, rows);
  assert.equal(built.defaultMode, 'data_flow');
  assert.deepEqual(Object.keys(built.variants), ['data_flow']);
  assert.deepEqual(built.variants.data_flow.relations, ['flow']);
  assert.ok(built.variants.data_flow.diagram.includes('atlas_graph -->'));
  assert.ok(!built.variants.data_flow.diagram.includes('atlas_end -->'));
  assert.ok(!built.variants.data_flow.diagram.includes('<storage>'));
});

test('dependency-only views retain modules without fabricating data flows from other views', () => {
  const modules = [{ id: 'a', name: 'Caller' }, { id: 'b', name: 'Provider' }];
  const rows = [
    { id: 'dep', from: 'a', to: 'b', kind: 'dependency', label: 'Uses provider' },
    { id: 'response', from: 'b', to: 'a', kind: 'data_flow', label: 'Result from another view' }
  ];
  const built = relationVariants({ modules: ['a', 'b'], relations: ['dep'], kind: 'dependency' }, modules, rows);
  assert.equal(built.defaultMode, 'data_flow');
  assert.deepEqual(built.variants.data_flow.relations, []);
  assert.deepEqual(built.variants.data_flow.edgeBindings, []);
  for (const diagram of [built.variants.data_flow.diagram, built.variants.data_flow.mobileDiagram]) {
    assert.match(diagram, /atlas_a\[/);
    assert.match(diagram, /atlas_b\[/);
    assert.doesNotMatch(diagram, /-->|-\.->/);
  }
});

test('relation evidence flows through snapshot, delta, refresh, context and generated report', async t => {
  const input = manifest(), dir = await fixture(t, input);
  assert.ok(collectSourceRows(input).some(row => row.key === 'relation:api_worker:0'));
  const hash = analysisManifestHash(input);
  const runtime = structuredClone(input); runtime.relations[0].freshness = 'stale'; runtime.relations[0].reviewRequired = true;
  assert.equal(analysisManifestHash(runtime), hash);
  run(dir, 'snapshot.mjs', 'atlas.json');
  const baseline = JSON.parse(await readFile(resolve(dir, '.repo-atlas/snapshot.json'), 'utf8'));
  assert.ok(baseline.impactIndex['src/order.js'].includes('relation:api_worker'));
  assert.ok(baseline.impactIndex['src/order.js'].includes('view:architecture'));
  await appendFile(resolve(dir, 'src/order.js'), '\n// Changed implementation fixture\n');
  run(dir, 'delta.mjs', 'atlas.json');
  run(dir, 'refresh.mjs', 'atlas.json');
  run(dir, 'context.mjs', 'atlas.json', '--changed-only');
  const candidate = JSON.parse(await readFile(resolve(dir, 'atlas.next.json'), 'utf8'));
  assert.equal(candidate.relations[0].reviewRequired, true);
  assert.equal(candidate.views.find(row => row.id === 'architecture').reviewRequired, true);
  const context = JSON.parse(await readFile(resolve(dir, '.repo-atlas/context.json'), 'utf8'));
  assert.ok(context.entities.some(row => row.key === 'relation:api_worker' && row.from === 'api' && row.to === 'worker'));
  assert.ok(context.relationships.declaredRelations.some(row => row.kind === 'data_flow'));
  run(dir, 'build.mjs', 'atlas.next.json');
  const html = await readFile(resolve(dir, 'report.html'), 'utf8');
  const data = JSON.parse(html.match(/<script id="graph-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.relations.length, 2);
  assert.equal(data.views.find(row => row.id === 'architecture').defaultRelationMode, 'data_flow');
  assert.deepEqual(data.views.find(row => row.id === 'architecture').relationDiagrams.data_flow.relations, ['audit_data']);
  assert.ok(data.relations[0].sources[0].excerpt);
});

test('motion bindings exclude dependencies and distinguish parallel transfers and reverse directions', () => {
  const modules = [{ id: 'a', name: 'Producer' }, { id: 'b', name: 'Consumer' }];
  const rows = [
    { id: 'depends', from: 'a', to: 'b', kind: 'dependency', label: 'Shared label' },
    { id: 'request', from: 'a', to: 'b', kind: 'data_flow', label: 'Shared label' },
    { id: 'response', from: 'b', to: 'a', kind: 'data_flow', label: 'Result' },
    { id: 'event', from: 'a', to: 'b', kind: 'data_flow', label: 'Shared label' }
  ];
  const { variants } = relationVariants({ modules: ['a', 'b'], relations: rows.map(row => row.id), kind: 'data_flow' }, modules, rows);
  assert.deepEqual(variants.data_flow.edgeBindings, [
    { edge: 'L-atlas_a-atlas_b-0', relation: 'request' },
    { edge: 'L-atlas_b-atlas_a-0', relation: 'response' },
    { edge: 'L-atlas_a-atlas_b-1', relation: 'event' }
  ]);
  assert.deepEqual(Object.keys(variants), ['data_flow']);
});

test('table references reject missing fields and unresolved relations remain explicit in review', async t => {
  const input = manifest();
  input.tables = [{ name: 'orders', title: 'Orders', kind: 'logical', description: 'Fixture', fields: [{ name: 'id', type: 'string', description: 'ID', references: { table: 'orders', field: 'absent', kind: 'logical' } }], sources: input.modules[0].sources }];
  assert.ok(validateManifest(input).some(row => row.path === '/tables/0/fields/0/references/field'));
  delete input.tables;
  input.relations[0].sources = [{ path: 'src/order.js', match: 'missing-relation-anchor', length: 1 }];
  const dir = await fixture(t, input);
  run(dir, 'build.mjs', 'atlas.json', '--review');
  const html = await readFile(resolve(dir, 'report.html'), 'utf8');
  const data = JSON.parse(html.match(/<script id="graph-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.relations[0].sources[0].state, 'unresolved');
  assert.equal(data.relations[0].sources[0].excerpt, null);
  assert.equal(data.views.find(view => view.id === 'architecture').reviewRequired, true);
});
