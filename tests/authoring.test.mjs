import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, appendFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { copyFixture } from '../scripts/fixture-lib.mjs';
import { analyzeImpact, collectSourceRows, createSnapshot, loadManifest } from '../scripts/snapshot-lib.mjs';
import { validateManifest } from '../scripts/manifest-lib.mjs';
import { resolveEvidence, hashText } from '../scripts/evidence-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const original = JSON.parse(await readFile(resolve(root, 'tests/fixtures/multi-chain/atlas.json'), 'utf8'));
const put = (dir, name, value) => writeFile(resolve(dir, name), JSON.stringify(value));
const json = async (dir, name) => JSON.parse(await readFile(resolve(dir, name), 'utf8'));
function run(dir, command, args = [], expected = 0) {
  const result = spawnSync(process.execPath, [resolve(root, 'scripts', command + '.mjs'), ...args], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, expected, result.stderr || result.stdout);
  return result;
}
async function fixture(t) {
  const dir = await mkdtemp(resolve(tmpdir(), 'atlas-authoring-'));
  t.after(async () => { assert.ok(dir.startsWith(resolve(tmpdir(), 'atlas-authoring-'))); await rm(dir, { recursive: true, force: true }); });
  await copyFixture(dir);
  return dir;
}

test('initialization is an explicitly incomplete scaffold and doctor stays read-only on valid and malformed inputs', async t => {
  const dir = await fixture(t), before = await readFile(resolve(dir, 'src/order.js'));
  run(dir, 'init', ['.', '--source', 'src/order.js']);
  const path = 'docs/architecture/atlas.json', input = await readFile(resolve(dir, path), 'utf8');
  const manifest = JSON.parse(input);
  assert.deepEqual(validateManifest(manifest), []);
  assert.equal(manifest.coverage[0].status, 'unknown');
  const diagnosis = JSON.parse(run(dir, 'doctor', [path, '--json']).stdout);
  assert.equal(diagnosis.readOnly, true);
  assert.equal(diagnosis.valid, true);
  assert.ok(diagnosis.warnings.some(row => row.code === 'analysis.incomplete'));
  run(dir, 'doctor', [path, '--strict'], 1);
  run(dir, 'init', ['.', '--source', 'src/order.js'], 1);
  assert.equal(await readFile(resolve(dir, path), 'utf8'), input);
  assert.deepEqual(await readFile(resolve(dir, 'src/order.js')), before);
  const invalid = structuredClone(manifest); invalid.modules[0].sources = { some: true };
  await put(dir, 'invalid.json', invalid);
  const bad = JSON.parse(run(dir, 'doctor', ['invalid.json', '--json'], 1).stdout);
  assert.equal(bad.valid, false);
  run(dir, 'build', [path]);
});

test('migration assigns stable IDs and pins real excerpts without replacing its inputs', async t => {
  const dir = await fixture(t), before = await readFile(resolve(dir, 'atlas.json'), 'utf8');
  run(dir, 'migrate', ['atlas.json', '--output', 'nested/migrated.json', '--pin-evidence']);
  const migrated = await json(dir, 'nested/migrated.json');
  assert.deepEqual(validateManifest(migrated), []);
  assert.equal(migrated.workspace, '..');
  assert.ok(collectSourceRows(migrated).every(row => row.id && /^[a-f0-9]{64}$/.test(row.excerptSha256)));
  assert.equal(await readFile(resolve(dir, 'atlas.json'), 'utf8'), before);
  run(dir, 'migrate', ['atlas.json', '--output', 'atlas.json'], 1);
  run(dir, 'migrate', ['atlas.json', '--output', 'nested/migrated.json'], 1);
  run(dir, 'build', ['nested/migrated.json']);
  await appendFile(resolve(dir, 'src/order.js'), '\n// outside pinned excerpts\n');
  run(dir, 'validate', ['nested/migrated.json']);
  const changed = (await readFile(resolve(dir, 'src/order.js'), 'utf8')).replace('export function createOrder', 'export async function createOrder');
  await writeFile(resolve(dir, 'src/order.js'), changed);
  run(dir, 'validate', ['nested/migrated.json'], 1);
});

test('impact traversal follows one data-flow hop without spreading overview membership or ignoring dependency fallback', () => {
  const modules = ['a', 'b', 'c', 'd'].map(id => ({ id, name: id }));
  const manifest = {
    modules,
    relations: [{ id: 'ab', from: 'a', to: 'b', kind: 'data_flow' }, { id: 'bc', from: 'b', to: 'c', kind: 'data_flow' }, { id: 'cd', from: 'c', to: 'd', kind: 'data_flow' }],
    views: [{ id: 'overview', modules: ['a', 'b', 'c', 'd'], relations: ['ab', 'bc', 'cd'] }]
  };
  const result = analyzeImpact(manifest, ['module:a', 'view:overview']);
  assert.ok(result.impacted.includes('module:b'));
  assert.ok(!result.impacted.includes('module:c') && !result.impacted.includes('module:d'));
  assert.deepEqual(result.paths['module:b'], ['module:a', 'module:b']);
  manifest.relations = [{ id: 'dependency', from: 'a', to: 'b', kind: 'dependency' }];
  assert.ok(analyzeImpact(manifest, ['module:a']).impacted.includes('module:b'));
});

test('fine-grained evidence bindings and closed runtime state reject invalid references and typos', () => {
  const input = structuredClone(original);
  input.modules[0].sources[0].id = 'main';
  input.modules[0].evidenceBindings = [{ target: '/facts/0', sources: ['main'] }];
  assert.deepEqual(validateManifest(input), []);
  input.modules[0].evidenceBindings[0].sources[0] = 'missing';
  assert.ok(validateManifest(input).some(row => row.path.endsWith('/evidenceBindings/0/sources/0')));
  input.modules[0].evidenceBindings[0] = { target: '/facts/100', sources: ['main'] };
  assert.ok(validateManifest(input).some(row => row.code === 'reference.target'));
  input.update = { reviewRequred: true };
  input.review = { version: 'test', reviewer: 'test', binding: { typo: 'bad' } };
  const errors = validateManifest(input);
  assert.ok(errors.some(row => row.path === '/update/reviewRequred'));
  assert.ok(errors.some(row => row.path === '/review/binding/typo'));
});

test('external assets are reused immutably and bundled source links survive relocation', async t => {
  const dir = await fixture(t);
  const result = JSON.parse(run(dir, 'build', ['atlas.json', '--assets-dir', '.repo-atlas/assets', '--source-bundle', '.repo-atlas/sources']).stdout);
  const html = await readFile(resolve(dir, 'report.html'), 'utf8');
  assert.ok(Buffer.byteLength(html) < 100000);
  assert.ok(result.bundleFiles.length >= 6);
  const data = JSON.parse(html.match(/<script id="graph-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(await readFile(resolve(dir, data.sourceBase, 'src/order.js')), await readFile(resolve(dir, 'src/order.js')));
  run(dir, 'build', ['atlas.json', '--assets-dir', '.repo-atlas/assets', '--source-bundle', '.repo-atlas/sources', '--replace']);
  const asset = result.bundleFiles.find(path => path.endsWith('app.js'));
  await appendFile(asset, '\n// corrupt immutable asset');
  run(dir, 'build', ['atlas.json', '--assets-dir', '.repo-atlas/assets', '--replace'], 1);
  assert.equal(await readFile(resolve(dir, 'report.html'), 'utf8'), html);
  run(dir, 'build', ['atlas.json', '--assets-dir', '../escape', '--replace'], 1);
});

test('structured transitions participate in snapshots, review tasks and context, with unresolved evidence blocking acceptance', async t => {
  const dir = await fixture(t), input = structuredClone(original);
  const chain = input.chains[0];
  chain.transitions = [{ id: 'accepted', from: 'validation', to: 'publish', label: 'Valid input', status: 'inferred', async: true, guard: 'validation passes', transaction: 'local write boundary', sources: [{ id: 'guard', path: 'src/order.js', match: 'function validateOrder', length: 2 }] }];
  await put(dir, 'atlas.json', input);
  run(dir, 'snapshot', ['atlas.json']);
  const snapshot = await createSnapshot(await loadManifest(resolve(dir, 'atlas.json')));
  assert.ok(snapshot.evidence['chain-transition:create_order/accepted:guard']);
  await appendFile(resolve(dir, 'src/order.js'), '\n// changed implementation');
  run(dir, 'delta', ['atlas.json']);
  run(dir, 'refresh', ['atlas.json']);
  run(dir, 'context', ['atlas.json', '--changed-only']);
  const context = await json(dir, '.repo-atlas/context.json');
  assert.ok(context.entities.some(row => row.key === 'chain-transition:create_order/accepted' && row.transaction === 'local write boundary'));
  run(dir, 'review', ['atlas.next.json']);
  const review = await json(dir, '.repo-atlas/review.json');
  assert.ok(review.items.some(row => row.detail.entity === 'chain-transition:create_order/accepted'));
});

test('context anchors remain deterministic under repeated text, Unicode and control characters', () => {
  let state = 0x6d2b79f5;
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  for (let sample = 0; sample < 250; sample++) {
    const anchor = `anchor_${next()}_中文_😀_<>&"`;
    const before = `before_${next()}`, after = `after_${next()}`;
    const text = `${anchor}\n${before}\n${anchor}\n${after}\n${anchor}`;
    const source = { path: 'source.js', match: anchor, before, after, length: 2 };
    const result = resolveEvidence(text, source);
    assert.equal(result.line, 3);
    assert.equal(result.excerptSha256, hashText(anchor + '\n' + after));
    assert.equal(resolveEvidence(text, { ...source, excerptSha256: hashText('changed') }).resolved, false);
  }
});
