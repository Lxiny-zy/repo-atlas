import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, appendFile, mkdir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { copyFixture } from '../scripts/fixture-lib.mjs';
import { checkReportFreshness, embeddedReportData, generatorFingerprint } from '../scripts/provenance-lib.mjs';
import { collectFileInventory, inventoryHash, analysisManifestHash } from '../scripts/snapshot-lib.mjs';
import { reviewQualityWarnings } from '../scripts/quality-lib.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = (directory, command, ...args) => spawnSync(process.execPath, [resolve(root, 'scripts', command + '.mjs'), ...args], { cwd: directory, encoding: 'utf8', windowsHide: true });
async function fixture(t) {
  const directory = await mkdtemp(resolve(tmpdir(), 'atlas-provenance-'));
  t.after(async () => { assert.ok(directory.startsWith(resolve(tmpdir(), 'atlas-provenance-'))); await rm(directory, { recursive: true, force: true }); });
  await copyFixture(directory);
  return directory;
}

test('freshness checks detect source, authored manifest, renderer and missing report changes without rewriting', async t => {
  const dir = await fixture(t), manifestPath = resolve(dir, 'atlas.json'), reportPath = resolve(dir, 'report.html');
  assert.equal((await checkReportFreshness(manifestPath)).reasons[0], 'report-missing');
  let result = run(dir, 'examples', 'build', manifestPath);
  assert.equal(result.status, 0, result.stderr);
  const html = await readFile(reportPath, 'utf8');
  const data = embeddedReportData(html);
  assert.equal((await checkReportFreshness(manifestPath)).fresh, true);
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  assert.equal(data.fingerprint.toolVersion, pkg.version);
  assert.equal(data.fingerprint.toolSha256, (await generatorFingerprint()).sha256);
  assert.ok(Number.isFinite(Date.parse(data.fingerprint.generatedAt)));
  await appendFile(resolve(dir, 'src/order.js'), '\n// new source revision');
  assert.ok((await checkReportFreshness(manifestPath)).reasons.includes('sourceSha256'));
  result = run(dir, 'examples', 'check', manifestPath);
  assert.equal(result.status, 1);
  assert.equal(await readFile(reportPath, 'utf8'), html, 'check never repairs stale output');
  assert.equal(run(dir, 'examples', 'build', manifestPath).status, 0);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.modules[0].summary += ' revised';
  await writeFile(manifestPath, JSON.stringify(manifest));
  assert.ok((await checkReportFreshness(manifestPath)).reasons.includes('analysisManifestSha256'));
  assert.equal(run(dir, 'examples', 'build', manifestPath).status, 0);
  const current = await readFile(reportPath, 'utf8');
  await writeFile(reportPath, current.replace(/"toolSha256":"[a-f0-9]{64}"/, '"toolSha256":"' + '0'.repeat(64) + '"'));
  assert.ok((await checkReportFreshness(manifestPath)).reasons.includes('toolSha256'));
});

test('source fingerprint covers uncited inventory files and evidence outside declared file groups, including review mode', async t => {
  const dir = await fixture(t), manifestPath = resolve(dir, 'atlas.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(resolve(dir, 'src/uncited.js'), 'export const uncited = 1;');
  let result = run(dir, 'build', 'atlas.json'); assert.equal(result.status, 0, result.stderr);
  const before = embeddedReportData(await readFile(resolve(dir, 'report.html'), 'utf8')).fingerprint;
  assert.equal(before.sourceFiles, 3);
  await appendFile(resolve(dir, 'src/uncited.js'), '\n// change without an evidence reference');
  assert.ok((await checkReportFreshness(manifestPath)).reasons.includes('sourceSha256'));
  manifest.fileGroups = [];
  await writeFile(manifestPath, JSON.stringify(manifest));
  result = run(dir, 'build', 'atlas.json', '--replace'); assert.equal(result.status, 0, result.stderr);
  let fingerprint = embeddedReportData(await readFile(resolve(dir, 'report.html'), 'utf8')).fingerprint;
  assert.equal(fingerprint.sourceFiles, 2, 'evidence is included without fileGroups');
  assert.equal(fingerprint.sourceSha256, inventoryHash(await collectFileInventory({ manifest, workspace: await realpath(dir) })));
  assert.equal(fingerprint.analysisManifestSha256, analysisManifestHash(manifest));
  await rm(resolve(dir, 'src/order.js'));
  result = run(dir, 'build', 'atlas.json', '--replace', '--review'); assert.equal(result.status, 0, result.stderr);
  fingerprint = embeddedReportData(await readFile(resolve(dir, 'report.html'), 'utf8')).fingerprint;
  assert.equal(fingerprint.reviewMode, true);
  assert.equal(fingerprint.sourceFiles, 1);
  await writeFile(resolve(dir, 'src/order.js'), 'restored but unverified');
  assert.ok((await checkReportFreshness(manifestPath)).reasons.includes('review-preview'));
});

test('generator fingerprints detect implementation changes even when the package version is unchanged', async t => {
  const dir = await fixture(t);
  for (const path of ['schemas', 'scripts', 'assets/report/vendor']) await mkdir(resolve(dir, path), { recursive: true });
  await writeFile(resolve(dir, 'package.json'), JSON.stringify({ name: 'synthetic-tool', version: '1.0.0' }));
  await writeFile(resolve(dir, 'schemas/atlas.schema.json'), '{}');
  await writeFile(resolve(dir, 'scripts/build.mjs'), '// synthetic generator');
  await writeFile(resolve(dir, 'assets/report/app.js'), '// synthetic renderer');
  const before = await generatorFingerprint(dir);
  await appendFile(resolve(dir, 'assets/report/app.js'), '\n// newer implementation');
  const after = await generatorFingerprint(dir);
  assert.equal(before.version, after.version);
  assert.notEqual(before.sha256, after.sha256);
});

test('shared quality checks find unreachable cycles, distinguish explicit entries and remain reviewable', () => {
  const chain = {
    id: 'flow', title: 'Flow', stages: [
      { id: 'start', kind: 'entry', label: 'Start' },
      { id: 'orphan', kind: 'read', label: 'Orphan' },
      { id: 'done', kind: 'outcome', label: 'Done' }
    ], transitions: [{ from: 'start', to: 'done' }]
  };
  let warnings = reviewQualityWarnings({ chains: [chain] });
  assert.ok(warnings.some(item => item.code === 'unreachable-stage' && item.entity.endsWith('/orphan')));
  assert.ok(warnings.some(item => item.code === 'untyped-terminal' && item.entity.endsWith('/orphan')));
  chain.transitions.push({ from: 'orphan', to: 'orphan' });
  warnings = reviewQualityWarnings({ chains: [chain] });
  assert.ok(warnings.some(item => item.code === 'unreachable-stage' && item.entity.endsWith('/orphan')));
  assert.ok(!warnings.some(item => item.code === 'untyped-terminal' && item.entity.endsWith('/orphan')));
  chain.transitions.push({ from: 'start', to: 'orphan' });
  assert.ok(!reviewQualityWarnings({ chains: [chain] }).some(item => item.code === 'unreachable-stage'));
});
