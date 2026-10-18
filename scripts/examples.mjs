import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOptions } from './cli-lib.mjs';
import { checkReportFreshness } from './provenance-lib.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const options = parseOptions(process.argv.slice(2), {
  value: ['browser'], min: 1, max: 100,
  usage: 'Usage: node scripts/examples.mjs build|check|verify [atlas.json ...] [--browser chromium|firefox|webkit]'
});
const [command, ...manifests] = options._;
const browser = options.browser || 'chromium';
if (!['build', 'check', 'verify'].includes(command) || !['chromium', 'firefox', 'webkit'].includes(browser)) {
  console.error('Use build, check or verify and a supported browser'); process.exit(2);
}
const examples = manifests.length ? manifests.map(path => ({ manifest: resolve(path), reader: false })) : [
  { manifest: resolve(root, 'examples/order-journey/atlas.json'), reader: true },
  { manifest: resolve(root, 'tests/fixtures/multi-chain/atlas.json'), reader: false }
];
const run = (script, args) => {
  const result = spawnSync(process.execPath, [resolve(root, 'scripts', script), ...args], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
};
if (command === 'build') for (const example of examples) run('build.mjs', [example.manifest, '--replace']);
const results = [];
for (const example of examples) results.push(await checkReportFreshness(example.manifest));
console.log(JSON.stringify({ command, fresh: results.every(item => item.fresh), results }, null, 2));
if (results.some(item => !item.fresh)) {
  console.error('Examples are missing or stale. Run examples:build (or build.mjs for a custom manifest) first.');
  process.exit(1);
}
if (command === 'verify') for (const [index, example] of examples.entries()) run(example.reader ? 'verify-reader.mjs' : 'verify.mjs', [results[index].report, '--browser', browser]);
