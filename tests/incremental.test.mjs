import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm, realpath, symlink, link, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createSnapshot, loadManifest, analysisManifestHash } from '../scripts/snapshot-lib.mjs';
import { resolveEvidence } from '../scripts/evidence-lib.mjs';
import { atomicWrite } from '../scripts/io-lib.mjs';
import { baselineTexts } from '../scripts/git-lib.mjs';
import { copyFixture } from '../scripts/fixture-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = async (dir, path) => JSON.parse(await readFile(resolve(dir, path), 'utf8'));
const put = (dir, path, value) => writeFile(resolve(dir, path), JSON.stringify(value, null, 2));
const run = (cwd, script, ...args) => {
  const result = spawnSync(process.execPath, [resolve(root, 'scripts', script), ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result;
};
const reject = (cwd, script, pattern, ...args) => {
  const result = spawnSync(process.execPath, [resolve(root, 'scripts', script), ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, pattern);
};
const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const init = dir => { git(dir, 'init', '--quiet'); git(dir, 'add', '.'); git(dir, 'commit', '--quiet', '-m', 'fixture'); };
async function fixture(t, withGit = false) {
  const dir = await mkdtemp(resolve(tmpdir(), 'repo-atlas-regression-'));
  // Only delete the exact temporary workspace created by this test.
  t.after(async () => { assert.ok(dir.startsWith(resolve(tmpdir(), 'repo-atlas-regression-'))); await rm(dir, { recursive: true, force: true }); });
  await copyFixture(dir);
  if (withGit) init(dir);
  return dir;
}
async function change(dir, before = 'valid: true', after = 'valid: false', path = 'src/order.js') {
  const file = resolve(dir, path);
  await writeFile(file, (await readFile(file, 'utf8')).replace(before, after));
}
const snapshot = dir => run(dir, 'snapshot.mjs', 'atlas.json');
const delta = dir => run(dir, 'delta.mjs', 'atlas.json');
const context = dir => run(dir, 'context.mjs', 'atlas.json', '--changed-only');

test('ambiguous, explicit occurrence and invalid evidence use one contract', async t => {
  assert.equal(resolveEvidence('anchor\nanchor', { path: 'x', match: 'anchor' }).state, 'ambiguous');
  assert.equal(resolveEvidence('anchor\nanchor', { path: 'x', match: 'anchor', occurrence: 2 }).line, 2);
  assert.throws(() => resolveEvidence('x', { path: 'x', match: 'x', length: 61 }), /1..60/);
  const dir = await fixture(t);
  const file = resolve(dir, 'src/order.js');
  await writeFile(file, await readFile(file, 'utf8') + '\n// export function createOrder duplicate\n');
  snapshot(dir);
  assert.equal((await read(dir, '.repo-atlas/snapshot.json')).evidence['module:api:0'].state, 'ambiguous');
  reject(dir, 'build.mjs', /Ambiguous evidence anchor/, 'atlas.json');
});

test('overlapping groups include all extensions and deduplicate files', async t => {
  const dir = await fixture(t);
  await writeFile(resolve(dir, 'src/helper.ts'), 'export const helper = 1;');
  const manifest = await read(dir, 'atlas.json');
  manifest.fileGroups.push({ name: 'TS', paths: ['src'], extensions: ['.ts', '.js'] });
  await put(dir, 'atlas.json', manifest);
  const state = await createSnapshot(await loadManifest(resolve(dir, 'atlas.json')));
  assert.ok(state.files['src/helper.ts']);
  assert.equal(Object.keys(state.files).length, 3);
});

test('unowned file changes require review; module paths map uncited files', async t => {
  const dir = await fixture(t);
  await writeFile(resolve(dir, 'src/helper.js'), 'one');
  snapshot(dir);
  await writeFile(resolve(dir, 'src/helper.js'), 'two');
  delta(dir); run(dir, 'refresh.mjs', 'atlas.json');
  assert.equal((await read(dir, 'atlas.next.json')).update.reviewRequired, true);
  assert.equal((await read(dir, '.repo-atlas/delta.json')).unmappedChanges[0].path, 'src/helper.js');
  const manifest = await read(dir, 'atlas.json');
  manifest.modules[0].paths = ['src'];
  await put(dir, 'atlas.json', manifest); snapshot(dir);
  await writeFile(resolve(dir, 'src/helper.js'), 'three'); delta(dir); run(dir, 'refresh.mjs', 'atlas.json');
  const diff = await read(dir, '.repo-atlas/delta.json');
  assert.deepEqual(diff.changes[0].impact, ['module:api']);
  assert.equal(diff.unmappedChanges.length, 0);
  assert.equal((await read(dir, 'atlas.next.json')).modules[0].reviewRequired, true);
});

test('overlapping inventory caches preserve exclusions, group priority and freshness across snapshots', async t => {
  const dir = await fixture(t);
  await mkdir(resolve(dir, 'src/optional'));
  await writeFile(resolve(dir, 'src/optional/helper.ts'), 'export const value = 1;');
  const manifest = await read(dir, 'atlas.json');
  manifest.fileGroups = [
    { name: 'Primary', paths: ['src'], extensions: ['.js', '.ts'], exclude: ['optional'] },
    { name: 'Secondary', paths: ['src'], extensions: ['.ts', '.js'] }
  ];
  await put(dir, 'atlas.json', manifest);
  const bundle = await loadManifest(resolve(dir, 'atlas.json'));
  const first = await createSnapshot(bundle);
  assert.equal(first.files['src/order.js'].group, 'Primary');
  assert.equal(first.files['src/optional/helper.ts'].group, 'Secondary');
  await writeFile(resolve(dir, 'src/optional/helper.ts'), 'export const changed = 123;');
  await writeFile(resolve(dir, 'src/optional/new.ts'), 'export const added = true;');
  const second = await createSnapshot(bundle, first);
  assert.notEqual(second.files['src/optional/helper.ts'].sha256, first.files['src/optional/helper.ts'].sha256);
  assert.ok(second.files['src/optional/new.ts']);
});

test('redaction covers every context field and Git diffs, including old secrets', async t => {
  const dir = await fixture(t, true);
  const manifest = await read(dir, 'atlas.json');
  manifest.modules[0].summary = 'fixture-secret in summary';
  await put(dir, 'atlas.json', manifest); snapshot(dir);
  await change(dir, 'fixture-secret', 'fixture-secret-changed'); delta(dir); context(dir);
  const text = await readFile(resolve(dir, '.repo-atlas/context.json'), 'utf8');
  assert.ok(!text.includes('fixture-secret'));
  assert.match((await read(dir, '.repo-atlas/context.json')).changedFiles[0].diff, /REDACTED/);
  await put(dir, 'previous.json', manifest);
  manifest.findings[0].sources[0].redact = ['replacement-secret'];
  await put(dir, 'atlas.json', manifest); delta(dir); context(dir);
  assert.equal((await read(dir, '.repo-atlas/context.json')).changedFiles[0].diffUnavailableReason, 'baseline-redaction-policy-unavailable');
  run(dir, 'context.mjs', 'atlas.json', '--previous-manifest', 'previous.json');
  assert.ok(!((await readFile(resolve(dir, '.repo-atlas/context.json'), 'utf8')).includes('fixture-secret')));
});

test('dirty baseline retains actual historical evidence and explains unavailable full diff', async t => {
  const dir = await fixture(t, true);
  await change(dir, 'valid: true', 'valid: "dirty-baseline"'); snapshot(dir);
  await change(dir, 'dirty-baseline', 'current'); delta(dir); context(dir);
  const ctx = await read(dir, '.repo-atlas/context.json');
  assert.match(ctx.evidence.find(row => row.key === 'module:worker:0').previous.text, /dirty-baseline/);
  assert.equal(ctx.changedFiles[0].diffUnavailableReason, 'snapshot-content-differs-from-commit');
});

test('stage impact, previous summaries and unresolved review survive refresh', async t => {
  const dir = await fixture(t);
  const manifest = await read(dir, 'atlas.json');
  manifest.modules[2].reviewRequired = true;
  manifest.coverage = [{ id: 'input', area: 'Input', summary: 'Input coverage', status: 'covered', modules: ['api'], sources: manifest.modules[0].sources }];
  await put(dir, 'atlas.json', manifest); snapshot(dir);
  const previous = structuredClone(manifest);
  previous.modules[0].summary = 'explicit previous summary';
  previous.coverage[0].summary = 'explicit previous coverage';
  await put(dir, 'previous.json', previous);
  await change(dir); delta(dir);
  run(dir, 'context.mjs', 'atlas.json', '--previous-manifest', 'previous.json');
  run(dir, 'refresh.mjs', 'atlas.json');
  const ctx = await read(dir, '.repo-atlas/context.json');
  assert.ok(ctx.entities.some(row => row.type === 'chain-stage'));
  assert.equal(ctx.entities.find(row => row.key === 'module:api').previousSummary, 'explicit previous summary');
  assert.equal(ctx.entities.find(row => row.type === 'coverage').previousSummary, 'explicit previous coverage');
  const next = await read(dir, 'atlas.next.json');
  assert.ok(next.chains[0].stages.some(stage => stage.reviewRequired));
  assert.equal(next.chains[0].reviewRequired, true);
  assert.equal(next.modules[2].reviewRequired, true);
});

test('nested manifest defaults and relocated candidates preserve workspace and semantic hash', async t => {
  const dir = await fixture(t);
  await mkdir(resolve(dir, '中文 空格'));
  const manifest = await read(dir, 'atlas.json'); manifest.workspace = '..';
  await put(dir, '中文 空格/atlas.json', manifest);
  const cwd = resolve(dir, '中文 空格'); snapshot(cwd); delta(cwd); run(cwd, 'refresh.mjs', 'atlas.json');
  const next = await loadManifest(resolve(cwd, 'atlas.next.json'));
  assert.equal(next.workspace, await realpath(dir));
  run(cwd, 'refresh.mjs', 'atlas.json', '--output', 'elsewhere/deep/next.json');
  const relocated = await loadManifest(resolve(dir, 'elsewhere/deep/next.json'));
  assert.equal(relocated.workspace, next.workspace);
  relocated.manifest.chains[0].stages[0].freshness = 'stale';
  assert.equal(analysisManifestHash(relocated.manifest), analysisManifestHash(manifest));
});

test('all incremental outputs reject input collisions before writing', async t => {
  const dir = await fixture(t); snapshot(dir); delta(dir);
  const original = await readFile(resolve(dir, 'atlas.json'), 'utf8');
  for (const script of ['snapshot.mjs', 'delta.mjs', 'refresh.mjs', 'context.mjs']) reject(dir, script, /overwrite an input/, 'atlas.json', '--output', 'atlas.json');
  reject(dir, 'delta.mjs', /overwrite an input/, 'atlas.json', '--snapshot-output', 'new.json', '--output', 'new.json');
  await assert.rejects(readFile(resolve(dir, 'new.json')), /ENOENT/);
  await mkdir(resolve(dir, 'internal'));
  await symlink(resolve(dir, 'internal'), resolve(dir, 'internal-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  reject(dir, 'delta.mjs', /overwrite an input/, 'atlas.json', '--snapshot-output', 'internal/new.json', '--output', 'internal-alias/new.json');
  await assert.rejects(readFile(resolve(dir, 'internal/new.json')), /ENOENT/);
  reject(dir, 'delta.mjs', /overwrite an input/, 'atlas.json', '--output', '.repo-atlas/snapshot.json');
  reject(dir, 'context.mjs', /must use .json/, 'atlas.json', '--out', 'src/order.js');
  await link(resolve(dir, 'atlas.json'), resolve(dir, 'alias.json'));
  reject(dir, 'refresh.mjs', /overwrite an input/, 'atlas.json', '--output', 'alias.json');
  assert.equal(await readFile(resolve(dir, 'atlas.json'), 'utf8'), original);
});

test('context and refresh reject source, manifest and baseline drift', async t => {
  const dir = await fixture(t); snapshot(dir); await change(dir); delta(dir);
  await change(dir, 'valid: false', 'valid: "after-delta"');
  for (const script of ['context.mjs', 'refresh.mjs']) reject(dir, script, /Source drift/, 'atlas.json');
  delta(dir);
  const manifest = await read(dir, 'atlas.json'); manifest.modules[0].summary += ' revised'; await put(dir, 'atlas.json', manifest);
  reject(dir, 'context.mjs', /manifest\/workspace drift/, 'atlas.json'); delta(dir);
  const baseline = await read(dir, '.repo-atlas/snapshot.json'); baseline.generatedAt = 'altered'; await put(dir, '.repo-atlas/snapshot.json', baseline);
  reject(dir, 'refresh.mjs', /baseline mismatch/, 'atlas.json');
});

test('output junction escapes and dangling file links are rejected; atomic replacement preserves old data on failure', async t => {
  const dir = await fixture(t), other = await fixture(t);
  await symlink(other, resolve(dir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  reject(dir, 'snapshot.mjs', /ancestor escapes workspace/, 'atlas.json', '--output', 'escape/snapshot.json');
  await assert.rejects(readFile(resolve(other, 'snapshot.json')), /ENOENT/);
  try { await symlink(resolve(other, 'missing.json'), resolve(dir, 'dangling.json'), 'file'); }
  catch (error) { if (error.code !== 'EPERM') throw error; }
  if (await readFile(resolve(dir, 'dangling.json')).then(() => false, error => error.code === 'ENOENT')) {
    // On Windows without link privileges the directory-junction assertion above still runs.
    const { lstat } = await import('node:fs/promises');
    if (await lstat(resolve(dir, 'dangling.json')).catch(() => null)) reject(dir, 'snapshot.mjs', /symbolic link/, 'atlas.json', '--output', 'dangling.json');
  }
  await writeFile(resolve(dir, 'atomic.json'), 'old');
  await assert.rejects(atomicWrite(await realpath(dir), 'atomic.json', 'new', { replace: false }), /already exists/);
  assert.equal(await readFile(resolve(dir, 'atomic.json'), 'utf8'), 'old');
  await atomicWrite(await realpath(dir), 'atomic.json', 'new');
  assert.equal(await readFile(resolve(dir, 'atomic.json'), 'utf8'), 'new');
});

test('equal-content multiple additions/deletions are not guessed as renames', async t => {
  const dir = await fixture(t);
  for (const path of ['a', 'b']) await writeFile(resolve(dir, 'src/' + path + '.js'), 'same');
  snapshot(dir);
  await rename(resolve(dir, 'src/a.js'), resolve(dir, 'src/c.js'));
  await rename(resolve(dir, 'src/b.js'), resolve(dir, 'src/d.js'));
  delta(dir);
  const diff = await read(dir, '.repo-atlas/delta.json');
  assert.equal(diff.summary.renamed, 0); assert.equal(diff.summary.added, 2); assert.equal(diff.summary.deleted, 2);
});

test('old evidence follows stored identity when anchor/path changes or source is removed', async t => {
  const dir = await fixture(t); snapshot(dir);
  const manifest = await read(dir, 'atlas.json');
  manifest.modules[0].sources[0].match = 'function validateOrder';
  manifest.modules[0].sources[0].path = 'src/renamed.js';
  await rename(resolve(dir, 'src/order.js'), resolve(dir, 'src/renamed.js'));
  await put(dir, 'atlas.json', manifest); delta(dir); context(dir);
  const ctx = await read(dir, '.repo-atlas/context.json');
  const row = ctx.evidence.find(row => row.key === 'module:api:0');
  assert.match(row.previous.text, /createOrder/);
  assert.match(row.current.text, /validateOrder/);
  assert.ok(ctx.evidence.some(row => row.current === null && row.currentUnavailableReason));
  assert.equal(ctx.changedFiles[0].status, 'renamed');
});

test('multi-repository history and Git subdirectory prefixes use each actual baseline', async t => {
  const dir = await fixture(t);
  for (const name of ['alpha', 'beta']) {
    await mkdir(resolve(dir, name));
    await cp(resolve(dir, 'src'), resolve(dir, name, 'nested/src'), { recursive: true });
    init(resolve(dir, name));
  }
  const manifest = await read(dir, 'atlas.json');
  manifest.repositories = [{ path: 'alpha/nested' }, { path: 'beta/nested' }];
  manifest.fileGroups[0].paths = ['alpha/nested/src', 'beta/nested/src'];
  const prefix = value => {
    if (!value || typeof value !== 'object') return;
    if (value.path?.startsWith('src/')) value.path = 'alpha/nested/' + value.path;
    for (const child of Object.values(value)) prefix(child);
  };
  prefix(manifest); await put(dir, 'atlas.json', manifest); snapshot(dir);
  await change(dir, 'valid: true', 'valid: false', 'alpha/nested/src/order.js');
  await change(dir, 'valid: true', 'valid: "beta"', 'beta/nested/src/order.js');
  delta(dir); context(dir);
  const ctx = await read(dir, '.repo-atlas/context.json');
  assert.equal(ctx.changedFiles.length, 2);
  assert.ok(ctx.changedFiles.every(row => row.diff.includes('-  return { ...input, valid: true }')));
  assert.ok(ctx.changedFiles.every(row => row.diffUnavailableReason === null));
});

test('context budget bounds UTF-8 JSON with explicit omissions', async t => {
  const dir = await fixture(t); snapshot(dir); await change(dir); delta(dir);
  run(dir, 'context.mjs', 'atlas.json', '--max-bytes', '4096');
  const bytes = await readFile(resolve(dir, '.repo-atlas/context.json'));
  const ctx = JSON.parse(bytes);
  assert.ok(bytes.length <= 4096);
  assert.equal(ctx.budget.truncated, true);
  assert.ok(Object.keys(ctx.budget.omitted).length > 0);
});

test('v1 snapshot migration is explicit instead of silently mixing baselines', async t => {
  const dir = await fixture(t); snapshot(dir);
  const state = await read(dir, '.repo-atlas/snapshot.json'); state.schemaVersion = 1;
  await put(dir, '.repo-atlas/snapshot.json', state);
  reject(dir, 'delta.mjs', /create a v2 snapshot/, 'atlas.json');
});

test('pending unowned review survives another candidate refresh', async t => {
  const dir = await fixture(t);
  const manifest = await read(dir, 'atlas.json');
  manifest.update = { reviewRequired: true, unmappedChanges: [{ path: 'src/pending.js', status: 'deleted', reason: 'pending review' }] };
  await put(dir, 'atlas.json', manifest); snapshot(dir); delta(dir); run(dir, 'refresh.mjs', 'atlas.json');
  const next = await read(dir, 'atlas.next.json');
  assert.equal(next.update.reviewRequired, true);
  assert.equal(next.update.unmappedChanges[0].path, 'src/pending.js');
});

test('stable evidence IDs survive source reordering', async t => {
  const dir = await fixture(t);
  const manifest = await read(dir, 'atlas.json');
  manifest.modules[0].sources = [
    { id: 'entry', path: 'src/order.js', match: 'export function createOrder', length: 2 },
    { id: 'validate', path: 'src/order.js', match: 'function validateOrder', length: 2 }
  ];
  await put(dir, 'atlas.json', manifest); snapshot(dir);
  manifest.modules[0].sources.reverse(); await put(dir, 'atlas.json', manifest); delta(dir);
  const diff = await read(dir, '.repo-atlas/delta.json');
  assert.ok(!diff.staleEvidence.some(row => row.entity === 'module:api'));
  assert.ok((await read(dir, '.repo-atlas/snapshot.json')).evidence['module:api:entry']);
});

test('historical reads respect total byte budget with an explicit reason', async t => {
  const dir = await fixture(t, true); snapshot(dir);
  const state = await read(dir, '.repo-atlas/snapshot.json');
  const texts = baselineTexts(await realpath(dir), state, ['src/order.js', 'src/audit.js'], { maxBytes: state.files['src/order.js'].size });
  assert.match(texts.get('src/order.js').text, /createOrder/);
  assert.equal(texts.get('src/audit.js').text, null);
  assert.equal(texts.get('src/audit.js').reason, 'historic-read-budget');
});
