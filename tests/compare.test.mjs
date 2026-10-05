import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function fixture(t) {
  const dir = await mkdtemp(resolve(tmpdir(), 'atlas-compare-boundary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(resolve(root, 'tests/fixtures/multi-chain/atlas.json'), 'utf8'));
  const save = (name, data) => writeFile(resolve(dir, name), JSON.stringify(data));
  await save('base.json', manifest);
  await save('head.json', manifest);
  const run = (...args) => spawnSync(process.execPath, [resolve(root, 'scripts/compare.mjs'), ...args], { cwd: dir, encoding: 'utf8', windowsHide: true });
  return { dir, manifest, save, run };
}
test('compare reports semantic entity additions, removals and field changes', async t => {
  const dir = await mkdtemp(resolve(tmpdir(), 'atlas-compare-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(resolve(root, 'tests/fixtures/multi-chain/atlas.json'), resolve(dir, 'base.json'));
  const head = JSON.parse(await readFile(resolve(dir, 'base.json'), 'utf8'));
  head.modules[0].summary = 'Accepts and authenticates order requests.';
  head.modules.pop();
  head.views[0].modules = ['api', 'worker'];
  head.chains.pop();
  head.modules.push({ id: 'new-module', name: 'New module', summary: 'Newly mapped.', facts: [], links: [], sources: [{ path: 'src/audit.js', match: 'export function recordAudit', length: 1 }] });
  head.modules[1].links = ['new-module'];
  await writeFile(resolve(dir, 'head.json'), JSON.stringify(head));
  const run = spawnSync(process.execPath, [resolve(root, 'scripts/compare.mjs'), 'base.json', 'head.json', '--json'], { cwd: dir, encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.ok(result.summary.added >= 1);
  assert.ok(result.summary.removed >= 1);
  assert.ok(result.summary.changed >= 1);
  assert.equal(result.collections.modules.added[0].key, 'new-module');
  assert.equal(result.collections.modules.removed[0].key, 'audit');
  assert.ok(result.collections.modules.changed.length >= 1);
  assert.ok(result.collections.modules.changed[0].fields.some(field => field.path === '/summary'));
  assert.ok(result.collections.stages);
  assert.equal(result.summary.rootChanged, false);
});

test('compare preserves arbitrary business keys, nested arrays and prototype-like JSON keys', async t => {
  const { manifest, save, run } = await fixture(t);
  manifest.flags = [{ name: 'config', description: 'Business settings', sources: manifest.modules[0].sources, value: JSON.parse('{"output":"before","workspace":"before","update":1,"nested":[{"review":1,"freshness":"a"}],"__proto__":{"enabled":false}}') }];
  await save('base.json', manifest);
  manifest.flags[0].value = JSON.parse('{"output":"after","workspace":"after","update":2,"nested":[{"review":2,"freshness":"b"}],"__proto__":{"enabled":true}}');
  await save('head.json', manifest);
  const result = run('--json', 'base.json', 'head.json');
  assert.equal(result.status, 0, result.stderr);
  const diff = JSON.parse(result.stdout);
  assert.equal(diff.summary.changed, 1);
  const change = diff.collections.flags.changed[0];
  assert.deepEqual(change.fields.map(field => field.path), ['/value']);
  assert.deepEqual(change.after.value, manifest.flags[0].value);
  assert.equal(change.before.value.__proto__.enabled, false);
});

test('compare ignores only authored-entity runtime metadata and top-level location metadata', async t => {
  const { manifest, save, run } = await fixture(t);
  manifest.workspace = '../moved'; manifest.output = 'elsewhere.html'; manifest.$schema = './schema.json';
  manifest.modules[0].freshness = 'stale'; manifest.modules[0].reviewRequired = true;
  manifest.chains[0].stages[0].freshness = 'stale'; manifest.chains[0].stages[0].staleReason = 'Changed';
  await save('head.json', manifest);
  const result = run('base.json', 'head.json');
  assert.equal(result.status, 0, result.stderr);
  const diff = JSON.parse(result.stdout);
  assert.equal(diff.summary.changed, 0);
  assert.equal(diff.summary.rootChanged, false);
});

test('compare protects both inputs and hard-link aliases even with --replace', async t => {
  const { dir, run } = await fixture(t);
  const original = await readFile(resolve(dir, 'base.json'));
  await link(resolve(dir, 'base.json'), resolve(dir, 'alias.json'));
  for (const output of ['base.json', 'head.json', 'alias.json']) {
    const result = run('base.json', 'head.json', '--output', output, '--replace');
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /overwrite an input/);
    assert.deepEqual(await readFile(resolve(dir, output)), original);
  }
});

test('compare requires explicit replacement and creates nested output atomically', async t => {
  const { dir, run } = await fixture(t);
  await writeFile(resolve(dir, 'result.json'), 'keep original');
  assert.equal(run('base.json', 'head.json', '--output=result.json').status, 1);
  assert.equal(await readFile(resolve(dir, 'result.json'), 'utf8'), 'keep original');
  assert.equal(run('base.json', 'head.json', '--output=result.json', '--replace').status, 0);
  const result = run('base.json', 'head.json', '--output=nested/result.json', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(resolve(dir, 'nested/result.json'), 'utf8')), JSON.parse(result.stdout));
  assert.deepEqual(await readdir(resolve(dir, 'nested')), ['result.json']);
});

test('compare rejects traversal and directory-link escapes without writing outside its working directory', async t => {
  const { dir, run } = await fixture(t);
  await mkdir(resolve(dir, 'work'));
  await symlink(dir, resolve(dir, 'work/escape'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const output of ['../escape.json', 'escape/escape.json']) {
    const result = spawnSync(process.execPath, [resolve(root, 'scripts/compare.mjs'), '../base.json', '../head.json', '--output', output], { cwd: resolve(dir, 'work'), encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /escapes workspace/);
  }
  assert.equal((await readdir(dir)).includes('escape.json'), false);
  assert.equal(run('base.json', 'head.json', '--output=result.txt').status, 1);
});
