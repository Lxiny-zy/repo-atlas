import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, rm, mkdir, symlink, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateManifest, validateManifestFile, relocateSchema } from '../scripts/manifest-lib.mjs';
import { analysisManifestHash } from '../scripts/snapshot-lib.mjs';
import { copyFixture } from '../scripts/fixture-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const original = JSON.parse(await readFile(resolve(root, 'tests/fixtures/multi-chain/atlas.json'), 'utf8'));
const copy = () => structuredClone(original);
const put = (dir, name, value) => writeFile(resolve(dir, name), JSON.stringify(value));
function run(dir, script, ...args) {
  return spawnSync(process.execPath, [resolve(root, 'scripts', script), ...args], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 30000 });
}
async function fixture(t) {
  const dir = await mkdtemp(resolve(tmpdir(), 'atlas-manifest-test-'));
  t.after(async () => {
    assert.ok(dir.startsWith(resolve(tmpdir(), 'atlas-manifest-test-')));
    await rm(dir, { recursive: true, force: true });
  });
  await copyFixture(dir);
  return dir;
}

test('legacy, narrative, runtime fields and custom stage kinds remain valid', () => {
  const manifest = copy();
  assert.deepEqual(validateManifest(manifest), []);
  manifest.views = [{ id: 'overview', title: 'Flow', kind: 'narrative', modules: ['api'], notes: [['Flow', 'Read the stages.']] }];
  manifest.chains.forEach(chain => { chain.views = ['overview']; });
  manifest.chains[0].stages[0].kind = 'project_specific';
  manifest.modules[0].freshness = 'stale'; manifest.modules[0].reviewRequired = true;
  manifest.update = { reviewRequired: true }; manifest.review = { reviewer: 'Fixture' };
  manifest.$schema = 'https://example.invalid/never-fetch.json';
  assert.deepEqual(validateManifest(manifest), []);
  manifest.views = []; manifest.chains.forEach(chain => { chain.views = []; });
  assert.deepEqual(validateManifest(manifest), [], 'chains alone can generate reading views');
});

test('multiple field errors, duplicate identities and broken references are located together', () => {
  const manifest = copy();
  delete manifest.project.title;
  manifest.modules[0].summmary = 'typo';
  manifest.modules[1].id = manifest.modules[0].id;
  manifest.modules[0].links.push('missing');
  manifest.chains[0].stages[1].id = manifest.chains[0].stages[0].id;
  manifest.modules[0].sources = [{ ...manifest.modules[0].sources[0], id: 'anchor' }, { ...manifest.modules[0].sources[0], id: 'anchor', length: 61 }];
  const errors = validateManifest(manifest);
  for (const path of ['/project/title', '/modules/0/summmary', '/modules/1/id', '/modules/0/links/1', '/chains/0/stages/1/id', '/modules/0/sources/1/id', '/modules/0/sources/1/length']) assert.ok(errors.some(item => item.path === path), path);
  assert.equal(errors.find(item => item.path === '/modules/1/id').relatedPath, '/modules/0/id');
  assert.doesNotThrow(() => validateManifest({ ...manifest, modules: [null, 42], chains: [null], project: [] }));
});

test('conditional evidence and next checks reject empty or missing explanations', () => {
  const manifest = copy();
  manifest.chains[0].stages[0].sources = [];
  manifest.chains[1].stages[2].nextCheck = '   ';
  manifest.findings[0].status = 'unverified';
  manifest.coverage = [{ id: 'scope', area: 'Scope', summary: 'Partial', status: 'partial' }];
  delete manifest.views[0].diagram;
  const errors = validateManifest(manifest);
  for (const path of ['/chains/0/stages/0/sources', '/chains/1/stages/2/nextCheck', '/findings/0/nextCheck', '/coverage/0/sources', '/views/0/diagram']) assert.ok(errors.some(item => item.path === path), path);
  const empty = copy(); empty.views = []; empty.chains = [];
  assert.ok(validateManifest(empty).some(item => item.code === 'schema.anyOf'));
});

test('batch CLI continues after bad JSON and missing files without leaking input text', async t => {
  const dir = await fixture(t);
  await writeFile(resolve(dir, 'broken.json'), '{"password":"private-fixture-value",bad}');
  const outcome = run(dir, 'validate.mjs', 'broken.json', 'missing.json', 'atlas.json', '--json');
  assert.equal(outcome.status, 1, outcome.stderr);
  assert.equal(outcome.stderr, '');
  assert.ok(!outcome.stdout.includes('private-fixture-value'));
  const report = JSON.parse(outcome.stdout);
  assert.deepEqual(report.summary, { files: 3, valid: 1, errors: 2, warnings: 0 });
  assert.equal(report.results[0].diagnostics[0].code, 'input.json');
  assert.equal(report.results[1].diagnostics[0].code, 'input.read');
  assert.equal(report.results[2].checks.sources, true);
  assert.equal(run(dir, 'validate.mjs', 'atlas.json', '--typo').status, 2);
  const unavailable = copy(); unavailable.workspace = 'src/order.js';
  await put(dir, 'workspace-file.json', unavailable);
  const result = await validateManifestFile(resolve(dir, 'workspace-file.json'));
  assert.equal(result.valid, false);
  assert.equal(result.checks.sources, false);
  assert.equal(result.diagnostics[0].code, 'workspace.unavailable');
});

test('evidence diagnostics aggregate despite unrelated structure errors and review only downgrades unresolved evidence', async t => {
  const dir = await fixture(t), manifest = copy();
  delete manifest.project.title;
  manifest.modules[0].sources[0].match = 'missing-fixture-anchor';
  manifest.modules[1].sources[0].path = 'src/missing.js';
  manifest.modules[2].sources[0] = { path: 'src/order.js', match: 'return' };
  await put(dir, 'atlas.json', manifest);
  const full = await validateManifestFile(resolve(dir, 'atlas.json'));
  for (const code of ['schema.required', 'evidence.missing', 'evidence.fileMissing', 'evidence.ambiguous']) assert.ok(full.diagnostics.some(item => item.code === code), code);
  const review = await validateManifestFile(resolve(dir, 'atlas.json'), { review: true });
  assert.equal(review.valid, false);
  assert.ok(review.diagnostics.filter(item => item.code.startsWith('evidence.')).every(item => item.severity === 'warning'));
  const structural = await validateManifestFile(resolve(dir, 'atlas.json'), { structureOnly: true });
  assert.equal(structural.checks.sources, false);
  assert.ok(structural.diagnostics.every(item => !item.code.startsWith('evidence.')));
});

test('diagnostics redact unknown property names and never echo source or anchor values', async t => {
  const dir = await fixture(t), manifest = copy();
  manifest.modules[0]['fixture-secret'] = 'unused';
  manifest.modules[0].sources[0].match = 'missing fixture-secret';
  await put(dir, 'atlas.json', manifest);
  const text = JSON.stringify(await validateManifestFile(resolve(dir, 'atlas.json')));
  assert.ok(!text.includes('fixture-secret'));
  assert.ok(text.includes('[REDACTED]'));
  const diagnostic = (await validateManifestFile(resolve(dir, 'atlas.json'))).diagnostics.find(item => item.code === 'schema.unknownProperty');
  assert.equal(diagnostic.subject, '/modules/0/[REDACTED]');
  assert.equal(diagnostic.stage, 'validate/structure');
  assert.ok(Array.isArray(diagnostic.supportedFixes) && diagnostic.supportedFixes.length > 0);
  assert.equal(diagnostic.evidence.path, diagnostic.path);
});

test('path traversal, output collisions and escaping junctions remain errors in review mode', async t => {
  const dir = await fixture(t), external = await fixture(t), manifest = copy();
  manifest.modules[0].sources[0].path = '../outside.js';
  manifest.modules[1].sources[0].path = 'C:/outside.js';
  manifest.modules[2].sources[0].path = 'src\\audit.js';
  manifest.output = '../report.html';
  await put(dir, 'atlas.json', manifest);
  const result = await validateManifestFile(resolve(dir, 'atlas.json'), { review: true });
  assert.equal(result.valid, false);
  assert.equal(result.diagnostics.filter(item => item.code === 'schema.pattern').length, 3);
  assert.ok(result.diagnostics.some(item => item.code === 'output.invalid'));
  await symlink(external, resolve(dir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const linked = copy(); linked.modules[0].sources[0].path = 'escape/src/order.js';
  await put(dir, 'atlas.json', linked);
  assert.ok((await validateManifestFile(resolve(dir, 'atlas.json'), { review: true })).diagnostics.some(item => item.code === 'path.escape' && item.severity === 'error'));
  const collision = copy(); collision.output = 'input.html';
  await put(dir, 'input.html', collision);
  assert.ok((await validateManifestFile(resolve(dir, 'input.html'))).diagnostics.some(item => item.code === 'output.invalid'));
});

test('build and snapshot fail with aggregated diagnostics before creating outputs', async t => {
  const dir = await fixture(t), manifest = copy();
  delete manifest.project.title; manifest.modules[0].links = ['missing'];
  await put(dir, 'atlas.json', manifest);
  const before = await readdir(dir);
  for (const script of ['build.mjs', 'snapshot.mjs']) {
    const result = run(dir, script, 'atlas.json');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /\/project\/title/); assert.match(result.stderr, /\/modules\/0\/links\/0/);
  }
  assert.deepEqual(await readdir(dir), before);
});

test('editor links preserve semantic identity and remain valid through candidate relocation', async t => {
  const dir = await fixture(t), manifest = copy();
  const before = analysisManifestHash(manifest);
  manifest.$schema = 'schemas/atlas.schema.json';
  assert.equal(analysisManifestHash(manifest), before);
  await mkdir(resolve(dir, 'schemas')); await cp(resolve(root, 'schemas/atlas.schema.json'), resolve(dir, manifest.$schema));
  await put(dir, 'atlas.json', manifest);
  for (const [script, args] of [['snapshot.mjs', []], ['delta.mjs', []], ['refresh.mjs', ['--output', 'nested/atlas.next.json']]]) {
    const result = run(dir, script, 'atlas.json', ...args); assert.equal(result.status, 0, result.stderr);
  }
  const candidatePath = resolve(dir, 'nested/atlas.next.json');
  const candidate = JSON.parse(await readFile(candidatePath, 'utf8'));
  assert.equal(resolve(dirname(candidatePath), candidate.$schema), resolve(dir, manifest.$schema));
  assert.equal(analysisManifestHash(candidate), before);
  relocateSchema(candidate, candidatePath, resolve(dir, 'release/atlas.json'));
  assert.equal(resolve(dir, 'release', candidate.$schema), resolve(dir, manifest.$schema));
  const external = { $schema: 'https://example.invalid/schema' }; relocateSchema(external, candidatePath, resolve(dir, 'release/atlas.json'));
  assert.equal(external.$schema, 'https://example.invalid/schema');
});

test('chain and stage IDs each support 64 characters without concatenation collisions', async t => {
  const dir = await fixture(t), manifest = copy();
  manifest.chains[0].id = 'c'.repeat(64); manifest.chains[0].stages[0].id = 's'.repeat(64);
  manifest.chains[1].id = 'c__s'; manifest.chains[1].stages[0].id = 'entry';
  assert.deepEqual(validateManifest(manifest), []);
  await put(dir, 'atlas.json', manifest);
  const result = run(dir, 'build.mjs', 'atlas.json');
  assert.equal(result.status, 0, result.stderr);
});
