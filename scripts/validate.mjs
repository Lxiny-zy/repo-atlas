import { validateManifestFile } from './manifest-lib.mjs';
import { parseOptions } from './cli-lib.mjs';

const options = parseOptions(process.argv.slice(2), { boolean: ['json', 'structure-only', 'review'], max: Infinity, usage: 'Usage: node scripts/validate.mjs <atlas.json> [more.json ...] [--json] [--structure-only] [--review]' });
const files = options._;
const results = [];
// Bound memory across large manifests; each file caches its own source reads.
for (const file of files) results.push(await validateManifestFile(file, { structureOnly: Boolean(options['structure-only']), review: Boolean(options.review) }));
const diagnostics = results.flatMap(result => result.diagnostics);
const summary = { files: results.length, valid: results.filter(result => result.valid).length, errors: diagnostics.filter(item => item.severity === 'error').length, warnings: diagnostics.filter(item => item.severity === 'warning').length };
const report = { schemaVersion: 1, valid: summary.errors === 0, mode: options['structure-only'] ? 'structure' : options.review ? 'review' : 'full', results, summary };
if (options.json) console.log(JSON.stringify(report, null, 2));
else {
  for (const result of results) {
    console.log(`${result.valid ? 'PASS' : 'FAIL'} ${result.file}`);
    for (const item of result.diagnostics) console.log(`  ${item.severity} ${item.path || '/'} [${item.code}] ${item.message}`);
  }
  console.log(`${summary.files} files; ${summary.errors} errors; ${summary.warnings} warnings`);
}
process.exitCode = report.valid ? 0 : 1;
