import { cp, mkdir, mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createSnapshot, loadManifest, writeJson, parseOptions } from './snapshot-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = parseOptions(process.argv.slice(2), {
  boolean: ['git'], value: ['scales', 'samples', 'extra-evidence', 'groups'], min: 0,
  usage: 'Usage: node scripts/benchmark.mjs [--scales 1000,10000] [--samples 1] [--extra-evidence 0] [--groups 1] [--git]'
});
const integer = (value, min, max, label) => {
  const number = Number(value);
  if (!/^\d+$/.test(String(value)) || !Number.isInteger(number) || number < min || number > max) {
    console.error(`${label} must be an integer from ${min} to ${max}`); process.exit(2);
  }
  return number;
};
const scales = String(options.scales || '1000,10000').split(',').map(Number);
for (const size of scales) integer(size, 10, 50000, '--scales entries');
const samples = integer(options.samples ?? 1, 1, 10, '--samples');
const extraEvidence = integer(options['extra-evidence'] ?? 0, 0, 1000, '--extra-evidence');
const overlappingGroups = integer(options.groups ?? 1, 1, 20, '--groups');
const results = [];
for (const count of scales) for (let sample = 1; sample <= samples; sample++) {
  const workspace = await mkdtemp(resolve(tmpdir(), 'repo-atlas-benchmark-'));
  try {
    // Copy only inputs: generated reports from a prior local run are irrelevant.
    await cp(resolve(root, 'tests/fixtures/multi-chain/src'), resolve(workspace, 'src'), { recursive: true });
    const manifest = JSON.parse(await readFile(resolve(root, 'tests/fixtures/multi-chain/atlas.json'), 'utf8'));
    const groups = Math.ceil((count - 2) / 100);
    for (let index = 0; index < groups; index++) await mkdir(resolve(workspace, `src/group-${index}`));
    let cursor = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= count - 2) return;
        await writeFile(resolve(workspace, `src/group-${Math.floor(index / 100)}/file-${index}.js`), `// synthetic file ${index}\nexport const value = ${index};\n`.repeat(12));
      }
    }));
    for (let index = 0; index < extraEvidence; index++) {
      const file = index % (count - 2);
      manifest.modules.push({ id: `bench-${index}`, name: `Benchmark ${index}`, summary: 'Synthetic evidence density sample.', facts: [], links: [], sources: [{ path: `src/group-${Math.floor(file / 100)}/file-${file}.js`, match: `export const value = ${file};`, occurrence: 1, length: 1 }] });
    }
    for (let index = 1; index < overlappingGroups; index++) manifest.fileGroups.push({ ...manifest.fileGroups[0], name: `Overlap ${index}` });
    await writeFile(resolve(workspace, 'atlas.json'), writeJson(manifest));
    if (options.git) {
      await writeFile(resolve(workspace, '.gitignore'), '.repo-atlas/\nreport.html\natlas.next.json\n');
      const git = (...args) => execFileSync('git', ['-c', 'user.name=Benchmark', '-c', 'user.email=benchmark@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd: workspace, windowsHide: true, stdio: 'pipe' });
      git('init', '--quiet'); git('add', '.'); git('-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'Synthetic baseline');
    }
    const bundle = await loadManifest(resolve(workspace, 'atlas.json'));
    let peakRss = process.memoryUsage().rss;
    const timer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
    let cold, warm;
    const coldStart = performance.now();
    try {
      cold = await createSnapshot(bundle);
      const coldMs = performance.now() - coldStart;
      const warmStart = performance.now(); warm = await createSnapshot(bundle, cold);
      const warmMs = performance.now() - warmStart;
      await mkdir(resolve(workspace, '.repo-atlas'));
      await writeFile(resolve(workspace, '.repo-atlas/snapshot.json'), writeJson(warm));
      const run = (script, ...args) => {
        const start = performance.now();
        execFileSync(process.execPath, [resolve(root, 'scripts', script), 'atlas.json', ...args], { cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        return Math.round(performance.now() - start);
      };
      const buildMs = run('build.mjs');
      for (let index = 0; index < Math.ceil(count * .01); index++) await writeFile(resolve(workspace, `src/group-${Math.floor(index / 100)}/file-${index}.js`), `export const changed = ${index};\n`);
      const deltaMs = run('delta.mjs'), contextMs = run('context.mjs', '--changed-only');
      const context = JSON.parse(await readFile(resolve(workspace, '.repo-atlas/context.json'), 'utf8'));
      results.push({ sample, files: Object.keys(cold.files).length, evidence: cold.counts.evidence, coldSnapshotMs: Math.round(coldMs), warmSnapshotMs: Math.round(warmMs), snapshotProcessPeakRssMiB: Math.round(peakRss / 1024 / 1024), buildMs, deltaMs, contextMs, htmlBytes: (await stat(resolve(workspace, 'report.html'))).size, contextBytes: (await stat(resolve(workspace, '.repo-atlas/context.json'))).size, contextTruncated: context.budget.truncated });
    } finally { clearInterval(timer); }
  } finally {
    if (!workspace.startsWith(resolve(tmpdir(), 'repo-atlas-benchmark-'))) throw new Error('Unexpected benchmark workspace');
    await rm(workspace, { recursive: true, force: true });
  }
}
const metrics = ['coldSnapshotMs', 'warmSnapshotMs', 'buildMs', 'deltaMs', 'contextMs'];
const summaries = [...new Set(scales)].map(files => {
  const rows = results.filter(row => row.files === files);
  return { files, samples: rows.length, metrics: Object.fromEntries(metrics.map(key => {
    const values = rows.map(row => row[key]).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    return [key, { median: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2, p95: values[Math.ceil(values.length * .95) - 1] }];
  })) };
});
console.log(writeJson({ generatedAt: new Date().toISOString(), node: process.version, platform: process.platform, scenario: { kind: 'synthetic', samples, extraEvidence, overlappingGroups, gitHistory: Boolean(options.git), changeRatio: .01, memoryScope: 'Sampled RSS of the snapshot process only; excludes child processes and is not reset between samples.', percentile: 'Nearest-rank p95; small samples do not establish a latency distribution.' }, results, summaries }));
