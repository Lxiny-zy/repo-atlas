import { readFile, mkdir, mkdtemp, rename, rm, lstat } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadManifest, parseOptions, assertOutputInside, createSnapshot, writeJson, slash, hashText } from './snapshot-lib.mjs';
import { atomicWrite, inside } from './io-lib.mjs';
import { reviewState, validateReview, entityRows } from './review-lib.mjs';
import { redactValue, redactionValues } from './evidence-lib.mjs';
import { collectSourceRows } from './snapshot-lib.mjs';
import { relocateSchema } from './manifest-lib.mjs';

const options = parseOptions(process.argv.slice(2));
if (!options._[0] || !options.review || options.help) {
  console.error('Usage: node accept.mjs <atlas.next.json> --review .repo-atlas/review.json [--output-dir .repo-atlas/accepted/version]');
  process.exit(options.help ? 0 : 2);
}
const bundle = await loadManifest(options._[0]);
const reviewPath = assertOutputInside(bundle.workspace, options.review);
const review = JSON.parse(await readFile(reviewPath, 'utf8'));
const state = await reviewState(bundle);
validateReview(bundle, state, review);
const version = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
const output = assertOutputInside(bundle.workspace, options['output-dir'] || `.repo-atlas/accepted/${version}`);
const exists = async path => Boolean(await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; }));
if (await exists(output)) throw new Error('Accepted output directory already exists; choose a new version');
if ([bundle.manifestPath, reviewPath, state.baselinePath, state.deltaPath, ...Object.keys(state.current.files).map(path => resolve(bundle.workspace, path))].some(path => inside(output, path))) throw new Error('Accepted output directory contains an input');
await mkdir(dirname(output), { recursive: true });
assertOutputInside(bundle.workspace, output);
const staging = await mkdtemp(resolve(dirname(output), '.atlas-pending-'));
try {
  const accepted = structuredClone(bundle.manifest);
  for (const { row } of entityRows(accepted)) for (const field of ['freshness', 'reviewRequired', 'staleReason']) delete row[field];
  delete accepted.update;
  accepted.workspace = slash(relative(staging, bundle.workspace) || '.');
  accepted.output = slash(relative(bundle.workspace, resolve(staging, 'report.html')));
  accepted.review = { version, reviewer: review.reviewer.trim(), reviewedAt: review.reviewedAt, acceptedAt: new Date().toISOString(), binding: review.binding };
  const stageManifest = resolve(staging, 'atlas.json');
  relocateSchema(accepted, bundle.manifestPath, stageManifest);
  await atomicWrite(bundle.workspace, stageManifest, writeJson(accepted), { replace: false });
  // A formal build validates the whole candidate before publishing a version.
  execFileSync(process.execPath, [resolve(dirname(fileURLToPath(import.meta.url)), 'build.mjs'), stageManifest], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  // Recheck inputs and sources after building so acceptance cannot mix versions.
  const finalBundle = await loadManifest(bundle.manifestPath);
  const finalState = await reviewState(finalBundle);
  validateReview(finalBundle, finalState, review);
  const currentReview = JSON.parse(await readFile(reviewPath, 'utf8'));
  if (hashText(JSON.stringify(currentReview)) !== hashText(JSON.stringify(review))) throw new Error('Review changed during acceptance');
  accepted.output = slash(relative(bundle.workspace, resolve(output, 'report.html')));
  accepted.workspace = slash(relative(output, bundle.workspace) || '.');
  relocateSchema(accepted, stageManifest, resolve(output, 'atlas.json'));
  await atomicWrite(bundle.workspace, stageManifest, writeJson(accepted));
  const raw = writeJson(accepted);
  const snapshot = await createSnapshot({ manifest: accepted, raw, workspace: bundle.workspace, manifestPath: resolve(output, 'atlas.json') });
  if (snapshot.inventorySha256 !== state.current.inventorySha256) throw new Error('Source drift during acceptance');
  await atomicWrite(bundle.workspace, resolve(staging, 'snapshot.json'), writeJson(snapshot), { replace: false });
  const secrets = redactionValues(collectSourceRows(bundle.manifest));
  const receipt = redactValue({ ...accepted.review, purpose: 'atlas-acceptance', schemaVersion: 1, manifestSha256: hashText(raw), snapshotSha256: hashText(writeJson(snapshot)), items: review.items }, secrets);
  await atomicWrite(bundle.workspace, resolve(staging, 'review.json'), writeJson(receipt), { replace: false });
  const reportPath = resolve(staging, 'report.html');
  const reportBytes = await readFile(reportPath);
  const delivery = redactValue({
    schemaVersion: 1,
    purpose: 'repo-atlas-delivery',
    status: 'current',
    version,
    generatedAt: new Date().toISOString(),
    command: 'accept',
    artifact: { path: 'report.html', sha256: hashText(reportBytes.toString('utf8')), bytes: reportBytes.byteLength },
    inputs: {
      manifest: { path: 'atlas.json', sha256: hashText(raw), bytes: Buffer.byteLength(raw) },
      snapshot: { path: 'snapshot.json', sha256: hashText(writeJson(snapshot)), bytes: Buffer.byteLength(writeJson(snapshot)) },
      review: { path: 'review.json', sha256: hashText(writeJson(receipt)), bytes: Buffer.byteLength(writeJson(receipt)) }
    },
    source: { workspaceSha256: snapshot.workspaceSha256, inventorySha256: snapshot.inventorySha256, git: snapshot.git || null },
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    checks: ['manifest-validated', 'review-approved', 'source-bound', 'report-built', 'atomic-release']
  }, secrets);
  await atomicWrite(bundle.workspace, resolve(staging, 'delivery.json'), writeJson(delivery), { replace: false });
  assertOutputInside(bundle.workspace, output);
  if (await exists(output)) throw new Error('Accepted output directory appeared during build');
  await rename(staging, output);
  console.log(writeJson({ output, version, manifest: resolve(output, 'atlas.json'), baseline: resolve(output, 'snapshot.json'), report: resolve(output, 'report.html'), delivery: resolve(output, 'delivery.json') }));
} finally {
  if (!inside(bundle.workspace, staging) || !staging.startsWith(resolve(dirname(output), '.atlas-pending-'))) throw new Error('Unexpected staging path');
  await rm(staging, { recursive: true, force: true });
}
