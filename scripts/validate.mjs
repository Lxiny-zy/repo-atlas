import { validateManifestFile } from './manifest-lib.mjs';

const args = process.argv.slice(2);
const allowed = new Set(['--json', '--structure-only', '--review', '--help']);
const files = args.filter(arg => !arg.startsWith('--'));
if (args.some(arg => arg.startsWith('--') && !allowed.has(arg)) || !files.length || args.includes('--help')) {
  console.error('Usage: node scripts/validate.mjs <atlas.json> [more.json ...] [--json] [--structure-only] [--review]');
  process.exit(args.includes('--help') ? 0 : 2);
}
const results = [];
// Bound memory across large manifests; each file caches its own source reads.
for (const file of files) results.push(await validateManifestFile(file, { structureOnly: args.includes('--structure-only'), review: args.includes('--review') }));
const diagnostics = results.flatMap(result => result.diagnostics);
const summary = { files: results.length, valid: results.filter(result => result.valid).length, errors: diagnostics.filter(item => item.severity === 'error').length, warnings: diagnostics.filter(item => item.severity === 'warning').length };
const report = { schemaVersion: 1, valid: summary.errors === 0, mode: args.includes('--structure-only') ? 'structure' : args.includes('--review') ? 'review' : 'full', results, summary };
if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  for (const result of results) {
    console.log(`${result.valid ? 'PASS' : 'FAIL'} ${result.file}`);
    for (const item of result.diagnostics) console.log(`  ${item.severity} ${item.path || '/'} [${item.code}] ${item.message}`);
  }
  console.log(`${summary.files} files; ${summary.errors} errors; ${summary.warnings} warnings`);
}
process.exitCode = report.valid ? 0 : 1;
