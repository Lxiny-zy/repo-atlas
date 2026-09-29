import { readFile } from 'node:fs/promises';
import { loadManifest, parseOptions, createSnapshot, assertOutputInside, writeJson, protectedSourcePaths, assertBaselineWorkspace } from './snapshot-lib.mjs';
import { planOutput, atomicWrite } from './io-lib.mjs';

const options = parseOptions(process.argv.slice(2));
const manifestArg = options._[0];
if (!manifestArg || options.help) {
  console.error('Usage: node snapshot.mjs <atlas.json> [--output .repo-atlas/snapshot.json] [--from snapshot.json]');
  process.exit(options.help ? 0 : 2);
}
const bundle = await loadManifest(manifestArg);
const fromPath = options.from ? assertOutputInside(bundle.workspace, options.from) : null;
let previous = null;
if (fromPath) {
  previous = JSON.parse(await readFile(fromPath, 'utf8'));
  assertBaselineWorkspace(bundle, previous);
}
const snapshot = await createSnapshot(bundle, previous, { allowMissingSources: true });
const protectedPaths = [...protectedSourcePaths(bundle, { ...previous?.files, ...snapshot.files }), ...(fromPath ? [fromPath] : [])];
const output = planOutput(bundle.workspace, options.output || '.repo-atlas/snapshot.json', { protectedPaths });
await atomicWrite(bundle.workspace, output, writeJson(snapshot), { protectedPaths });
console.log(JSON.stringify({ output, ...snapshot.counts, commit: snapshot.git.shortCommit, dirty: snapshot.git.dirty }, null, 2));
