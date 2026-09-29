import { relative } from 'node:path';
import { loadManifest, parseOptions, protectedSourcePaths, writeJson, slash } from './snapshot-lib.mjs';
import { planOutput, atomicWrite } from './io-lib.mjs';
import { reviewState, reviewTasks, reviewBinding } from './review-lib.mjs';

const options = parseOptions(process.argv.slice(2));
if (!options._[0] || options.help) {
  console.error('Usage: node review.mjs <atlas.next.json> [--output .repo-atlas/review.json]');
  process.exit(options.help ? 0 : 2);
}
const bundle = await loadManifest(options._[0]);
const state = await reviewState(bundle);
const protectedPaths = [...protectedSourcePaths(bundle, { ...state.baseline.files, ...state.current.files }), state.baselinePath, state.deltaPath];
const output = planOutput(bundle.workspace, options.output || '.repo-atlas/review.json', { protectedPaths, replace: false });
const review = { schemaVersion: 1, purpose: 'atlas-review', generatedAt: new Date().toISOString(), candidate: slash(relative(bundle.workspace, bundle.manifestPath)), binding: reviewBinding(bundle, state), reviewer: '', reviewedAt: '', items: reviewTasks(bundle, state) };
await atomicWrite(bundle.workspace, output, writeJson(review), { protectedPaths, replace: false });
console.log(writeJson({ output, tasks: review.items.length, unresolved: review.items.filter(item => item.kind === 'unresolved-evidence').length }));
