import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadManifest, parseOptions, createSnapshot, assertOutputInside, writeJson } from './snapshot-lib.mjs';

const options = parseOptions(process.argv.slice(2));
const manifestArg = options._[0];
if (!manifestArg || options.help) {
  console.error('Usage: node snapshot.mjs <atlas.json> [--output .repo-atlas/snapshot.json] [--from snapshot.json]');
  process.exit(options.help ? 0 : 2);
}
const bundle = await loadManifest(manifestArg);
const output = assertOutputInside(bundle.workspace, options.output || '.repo-atlas/snapshot.json');
let previous = null;
if (options.from) previous = JSON.parse(await readFile(assertOutputInside(bundle.workspace, options.from), 'utf8'));
const snapshot = await createSnapshot(bundle, previous, { allowMissingSources: true });
await mkdir(dirname(output), { recursive: true });
await writeFile(output, writeJson(snapshot), { encoding: 'utf8', flag: 'w' });
console.log(JSON.stringify({ output, ...snapshot.counts, commit: snapshot.git.shortCommit, dirty: snapshot.git.dirty }, null, 2));
