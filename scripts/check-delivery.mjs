import { readFile, realpath, lstat } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { hashBytes, writeJson } from './snapshot-lib.mjs';
import { inside } from './io-lib.mjs';
import { parseOptions } from './cli-lib.mjs';

const options = parseOptions(process.argv.slice(2), { min: 0, max: 1, usage: 'Usage: node scripts/check-delivery.mjs [accepted-directory]' });
const root = await realpath(resolve(options._[0] || '.'));
const receiptPath = resolve(root, 'delivery.json');
const fail = message => { throw new Error(`Delivery check failed: ${message}`); };
const readBound = async (entry, label) => {
  if (!entry || typeof entry.path !== 'string' || !entry.path || isAbsolute(entry.path)) fail(`${label} path is not a relative file`);
  if (!/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) fail(`${label} binding is invalid`);
  const path = resolve(root, entry.path);
  if (!inside(root, path) || relative(root, path).startsWith('..')) fail(`${label} path escapes the accepted directory`);
  const canonical = await realpath(path).catch(() => fail(`${label} is missing`));
  if (!inside(root, canonical)) fail(`${label} link escapes the accepted directory`);
  if (!(await lstat(path)).isFile()) fail(`${label} must be a regular file`);
  const bytes = await readFile(path).catch(() => fail(`${label} is missing`));
  const actual = { sha256: hashBytes(bytes), bytes: bytes.byteLength };
  if (actual.sha256 !== entry.sha256) fail(`${label} hash mismatch`);
  if (actual.bytes !== entry.bytes) fail(`${label} byte count mismatch`);
  return { path, ...actual };
};

const delivery = JSON.parse(await readFile(receiptPath, 'utf8'));
if (!delivery || delivery.schemaVersion !== 1 || delivery.purpose !== 'repo-atlas-delivery' || delivery.status !== 'current') fail('receipt schema or status is invalid');
if (!/^[a-f0-9]{64}$/.test(delivery.source?.workspaceSha256) || !/^[a-f0-9]{64}$/.test(delivery.source?.inventorySha256)) fail('source binding is invalid');
const artifact = await readBound(delivery.artifact, 'artifact');
const manifest = await readBound(delivery.inputs?.manifest, 'manifest');
const snapshot = await readBound(delivery.inputs?.snapshot, 'snapshot');
const review = await readBound(delivery.inputs?.review, 'review');
const snapshotData = JSON.parse(await readFile(snapshot.path, 'utf8'));
if (delivery.source?.workspaceSha256 !== snapshotData.workspaceSha256) fail('workspace hash is not bound to snapshot');
if (delivery.source?.inventorySha256 !== snapshotData.inventorySha256) fail('inventory hash is not bound to snapshot');
const result = {
  schemaVersion: 1,
  valid: true,
  purpose: 'repo-atlas-delivery-check',
  delivery: delivery.version || null,
  checked: [artifact.path, manifest.path, snapshot.path, review.path],
  source: delivery.source,
  artifact: { sha256: artifact.sha256, bytes: artifact.bytes }
};
console.log(writeJson(result));
