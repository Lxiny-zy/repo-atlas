import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { hashText, writeJson } from './snapshot-lib.mjs';
import { inside } from './io-lib.mjs';

const root = resolve(process.argv[2] || '.');
const receiptPath = resolve(root, 'delivery.json');
const fail = message => { throw new Error(`Delivery check failed: ${message}`); };
const readBound = async (entry, label) => {
  if (!entry || typeof entry.path !== 'string' || isAbsolute(entry.path)) fail(`${label} path is not a relative file`);
  const path = resolve(root, entry.path);
  if (!inside(root, path) || relative(root, path).startsWith('..')) fail(`${label} path escapes the accepted directory`);
  const bytes = await readFile(path).catch(() => fail(`${label} is missing`));
  const actual = { sha256: hashText(bytes.toString('utf8')), bytes: bytes.byteLength };
  if (actual.sha256 !== entry.sha256) fail(`${label} hash mismatch`);
  if (actual.bytes !== entry.bytes) fail(`${label} byte count mismatch`);
  return { path, ...actual };
};

const delivery = JSON.parse(await readFile(receiptPath, 'utf8'));
if (delivery.schemaVersion !== 1 || delivery.purpose !== 'repo-atlas-delivery' || delivery.status !== 'current') fail('receipt schema or status is invalid');
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
