import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = async (dir, path) => JSON.parse(await readFile(resolve(dir, path), 'utf8'));
const put = (dir, path, value) => writeFile(resolve(dir, path), JSON.stringify(value, null, 2));
function run(dir, script, args = [], error = null) {
  const result = spawnSync(process.execPath, [resolve(root, 'scripts', script), ...args], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (error) { assert.notEqual(result.status, 0); assert.match(result.stderr, error); }
  else assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result;
}
async function fixture(t) {
  const dir = await mkdtemp(resolve(tmpdir(), 'atlas-review-test-'));
  t.after(async () => { assert.ok(dir.startsWith(resolve(tmpdir(), 'atlas-review-test-'))); await rm(dir, { recursive: true, force: true }); });
  await cp(resolve(root, 'tests/fixtures/multi-chain'), dir, { recursive: true });
  run(dir, 'snapshot.mjs', ['atlas.json']);
  const path = resolve(dir, 'src/order.js'); await writeFile(path, (await readFile(path, 'utf8')).replace('valid: true', 'valid: false'));
  run(dir, 'delta.mjs', ['atlas.json']); run(dir, 'refresh.mjs', ['atlas.json']);
  return dir;
}
const prepare = dir => run(dir, 'review.mjs', ['atlas.next.json']);
const accept = (dir, error = null, output = '.repo-atlas/accepted/test') => run(dir, 'accept.mjs', ['atlas.next.json', '--review', '.repo-atlas/review.json', '--output-dir', output], error);
async function approve(dir) {
  const review = await json(dir, '.repo-atlas/review.json');
  review.reviewer = 'Synthetic test reviewer'; review.reviewedAt = new Date().toISOString();
  for (const item of review.items) { item.decision = 'approved'; item.note = 'Synthetic fixture reviewed for regression testing.'; }
  await put(dir, '.repo-atlas/review.json', review);
  return review;
}

test('reviewed release contains report, receipt and usable baseline without replacing inputs', async t => {
  const dir = await fixture(t);
  const candidate = await json(dir, 'atlas.next.json');
  candidate.$schema = 'schemas/atlas.schema.json';
  await put(dir, 'atlas.next.json', candidate);
  const original = await readFile(resolve(dir, 'atlas.json'), 'utf8');
  const baseline = await readFile(resolve(dir, '.repo-atlas/snapshot.json'), 'utf8');
  prepare(dir); await approve(dir); accept(dir);
  const accepted = await json(dir, '.repo-atlas/accepted/test/atlas.json');
  assert.equal(resolve(dir, '.repo-atlas/accepted/test', accepted.$schema), resolve(dir, candidate.$schema));
  assert.equal(accepted.update, undefined);
  assert.ok(accepted.chains.every(chain => !chain.reviewRequired && chain.stages.every(stage => !stage.reviewRequired)));
  assert.equal(accepted.review.reviewer, 'Synthetic test reviewer');
  const receipt = await json(dir, '.repo-atlas/accepted/test/review.json');
  assert.equal(receipt.purpose, 'atlas-acceptance'); assert.ok(receipt.items.length > 0);
  const delivery = await json(dir, '.repo-atlas/accepted/test/delivery.json');
  assert.equal(delivery.purpose, 'repo-atlas-delivery');
  assert.equal(delivery.status, 'current');
  assert.equal(delivery.artifact.path, 'report.html');
  assert.equal(delivery.artifact.bytes, Buffer.byteLength(await readFile(resolve(dir, '.repo-atlas/accepted/test/report.html'))));
  assert.equal(delivery.inputs.manifest.sha256, receipt.manifestSha256);
  run(dir, 'check-delivery.mjs', ['.repo-atlas/accepted/test']);
  const reportPath = resolve(dir, '.repo-atlas/accepted/test/report.html');
  await writeFile(reportPath, `${await readFile(reportPath, 'utf8')}\n`);
  run(dir, 'check-delivery.mjs', ['.repo-atlas/accepted/test'], /artifact hash mismatch/);
  const report = await readFile(resolve(dir, '.repo-atlas/accepted/test/report.html'), 'utf8');
  const data = JSON.parse(report.match(/<script id="graph-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.review.reviewer, accepted.review.reviewer);
  assert.equal(data.reviewMode, false);
  assert.equal(await readFile(resolve(dir, 'atlas.json'), 'utf8'), original);
  assert.equal(await readFile(resolve(dir, '.repo-atlas/snapshot.json'), 'utf8'), baseline);
  run(dir, 'delta.mjs', ['.repo-atlas/accepted/test/atlas.json', '--from', '.repo-atlas/accepted/test/snapshot.json']);
  assert.equal((await json(dir, '.repo-atlas/delta.json')).summary.manifestChanged, false);
  assert.equal((await json(dir, '.repo-atlas/delta.json')).summary.changedFiles, 0);
});

test('accept requires complete reviewed decisions and never reuses an existing release directory', async t => {
  const dir = await fixture(t); prepare(dir);
  accept(dir, /requires reviewer/);
  const review = await approve(dir); review.items[0].decision = 'deferred'; await put(dir, '.repo-atlas/review.json', review);
  accept(dir, /Review incomplete/);
  review.items[0].decision = 'approved'; review.items[0].note = ''; await put(dir, '.repo-atlas/review.json', review);
  accept(dir, /Review incomplete/);
  await approve(dir); accept(dir); accept(dir, /directory already exists/);
  run(dir, 'review.mjs', ['atlas.next.json'], /already exists/);
});

test('review task tampering and candidate drift are rejected', async t => {
  const dir = await fixture(t); prepare(dir);
  const review = await approve(dir);
  const originalDetail = structuredClone(review.items[0].detail);
  review.items[0].detail.summary = 'Incorrect task description'; await put(dir, '.repo-atlas/review.json', review);
  accept(dir, /Review task changed/);
  review.items[0].detail = originalDetail; review.items.pop(); await put(dir, '.repo-atlas/review.json', review);
  accept(dir, /task set mismatch/);
  await rm(resolve(dir, '.repo-atlas/review.json')); prepare(dir); await approve(dir);
  const candidate = await json(dir, 'atlas.next.json'); candidate.modules[0].summary += ' edited after review'; await put(dir, 'atlas.next.json', candidate);
  accept(dir, /Review drift/);
});

test('source drift blocks acceptance and invalidates accepted report rebuilds', async t => {
  const dir = await fixture(t); prepare(dir); await approve(dir); accept(dir);
  await writeFile(resolve(dir, 'src/order.js'), (await readFile(resolve(dir, 'src/order.js'), 'utf8')) + '\n// new source revision\n');
  accept(dir, /Source drift/);
  run(dir, 'build.mjs', ['.repo-atlas/accepted/test/atlas.json', '--replace'], /Reviewed version drift/);
});

test('unresolved evidence is readable in review mode and cannot be accepted', async t => {
  const dir = await fixture(t);
  await rm(resolve(dir, 'src/order.js'));
  run(dir, 'delta.mjs', ['atlas.json']); run(dir, 'refresh.mjs', ['atlas.json']);
  run(dir, 'build.mjs', ['atlas.next.json'], /ENOENT/);
  run(dir, 'build.mjs', ['atlas.next.json', '--review']);
  const report = await readFile(resolve(dir, 'report.html'), 'utf8');
  const data = JSON.parse(report.match(/<script id="graph-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.reviewMode, true); assert.ok(data.unresolvedCount > 0);
  assert.equal(data.modules[0].sources[0].excerpt, null);
  assert.equal(data.modules[0].sources[0].line, null);
  assert.equal(data.modules[0].freshness, 'unresolved');
  assert.ok(data.chains[0].stages.every(stage => stage.status === 'unknown' && stage.declaredStatus === 'covered'));
  assert.equal(data.findings[0].status, 'unverified');
  const candidate = await json(dir, 'atlas.next.json');
  const escaped = structuredClone(candidate); escaped.modules[0].sources[0].path = '../outside-missing.js';
  await put(dir, 'atlas.next.json', escaped);
  run(dir, 'build.mjs', ['atlas.next.json', '--review', '--replace'], /\/modules\/0\/sources\/0\/path \[schema.pattern\]/);
  await put(dir, 'atlas.next.json', candidate);
  prepare(dir); await approve(dir); accept(dir, /Unresolved evidence cannot be accepted/);
  await assert.rejects(readFile(resolve(dir, '.repo-atlas/accepted/test/atlas.json')), /ENOENT/);
});

test('structural errors block review preparation before any review or release is written', async t => {
  const dir = await fixture(t);
  const candidate = await json(dir, 'atlas.next.json'); candidate.modules[0].links = ['missing_module'];
  await put(dir, 'atlas.next.json', candidate);
  run(dir, 'review.mjs', ['atlas.next.json'], /reference.unknown/);
  await assert.rejects(readFile(resolve(dir, '.repo-atlas/review.json')), /ENOENT/);
  await assert.rejects(readdir(resolve(dir, '.repo-atlas/accepted')), /ENOENT/);
});

test('strict build failure cleans staging and does not publish a partial release', async t => {
  const dir = await fixture(t);
  const candidate = await json(dir, 'atlas.next.json'); candidate.fileGroups[0].paths.push('missing-scan-root');
  await put(dir, 'atlas.next.json', candidate); prepare(dir); await approve(dir); accept(dir, /ENOENT/);
  assert.deepEqual(await readdir(resolve(dir, '.repo-atlas/accepted')), []);
});
