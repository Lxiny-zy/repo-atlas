import { dirname, relative } from 'node:path';
import { parseOptions } from './cli-lib.mjs';
import { loadManifest, checkedPath, protectedSourcePaths, writeJson } from './snapshot-lib.mjs';
import { manifestRows, assertManifest, relocateSchema } from './manifest-lib.mjs';
import { planOutput, atomicWrite } from './io-lib.mjs';
import { sourceReader, resolveEvidence, hashText } from './evidence-lib.mjs';

const options = parseOptions(process.argv.slice(2), {
  value: ['output'], required: ['output'], boolean: ['pin-evidence'],
  usage: 'Usage: node scripts/migrate.mjs <atlas.json> --output atlas.migrated.json [--pin-evidence]'
});
const bundle = await loadManifest(options._[0]);
const protectedPaths = protectedSourcePaths(bundle);
const output = planOutput(bundle.workspace, options.output, { protectedPaths, replace: false });
const next = structuredClone(bundle.manifest);
const read = sourceReader(path => checkedPath(bundle.workspace, path));
let assigned = 0, pinned = 0;
for (const { row } of manifestRows(next)) {
  const ids = new Set((row.sources || []).map(source => source.id).filter(Boolean));
  for (const source of row.sources || []) {
    if (!source.id) {
      const base = 'source_' + hashText(JSON.stringify([source.path, source.match, source.occurrence || 1])).slice(0, 12);
      let id = base, suffix = 0;
      while (ids.has(id)) id = `${base}_${++suffix}`;
      source.id = id; ids.add(id); assigned++;
    }
    if (options['pin-evidence']) {
      const result = resolveEvidence((await read(source.path)).document, source);
      if (!result.resolved) throw new Error('Cannot pin unresolved evidence; repair the input first');
      source.excerptSha256 = result.excerptSha256; pinned++;
    }
  }
}
next.manifestVersion = 1;
next.workspace = relative(dirname(output), bundle.workspace).replaceAll('\\', '/') || '.';
relocateSchema(next, bundle.manifestPath, output);
// IDs and pins change the authored definition. Old acceptance cannot be reused.
delete next.review; delete next.update;
assertManifest(next);
await atomicWrite(bundle.workspace, output, writeJson(next), { protectedPaths, replace: false });
console.log(writeJson({ output, assigned, pinned, next: 'Review the migrated manifest and recreate the snapshot baseline before incremental work.' }));
