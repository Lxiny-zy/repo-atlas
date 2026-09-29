import { cp, mkdir, mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createSnapshot, loadManifest, writeJson, parseOptions } from './snapshot-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = parseOptions(process.argv.slice(2));
const scales = String(options.scales || '1000,10000').split(',').map(Number);
if (scales.some(size => !Number.isInteger(size) || size < 10 || size > 50000)) throw new Error('--scales must list integers between 10 and 50000');
const results = [];
for (const count of scales) {
  const workspace = await mkdtemp(resolve(tmpdir(), 'repo-atlas-benchmark-'));
  try {
    await cp(resolve(root, 'tests/fixtures/multi-chain'), workspace, { recursive: true });
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
      results.push({ files: Object.keys(cold.files).length, evidence: cold.counts.evidence, coldSnapshotMs: Math.round(coldMs), warmSnapshotMs: Math.round(warmMs), snapshotProcessPeakRssMiB: Math.round(peakRss / 1024 / 1024), buildMs, deltaMs, contextMs, htmlBytes: (await stat(resolve(workspace, 'report.html'))).size, contextBytes: (await stat(resolve(workspace, '.repo-atlas/context.json'))).size, contextTruncated: context.budget.truncated });
    } finally { clearInterval(timer); }
  } finally {
    if (!workspace.startsWith(resolve(tmpdir(), 'repo-atlas-benchmark-'))) throw new Error('Unexpected benchmark workspace');
    await rm(workspace, { recursive: true, force: true });
  }
}
console.log(writeJson({ generatedAt: new Date().toISOString(), node: process.version, platform: process.platform, scenario: 'Synthetic files, 12 evidence references, 1% uncited changes, no Git history; one sample per scale. RSS measures snapshot process only.', results }));
