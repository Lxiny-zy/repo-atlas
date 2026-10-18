import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile, hashText } from './evidence-lib.mjs';
import { loadManifest, analysisManifestHash, collectFileInventory, inventoryHash } from './snapshot-lib.mjs';
import { assertOutputInside } from './io-lib.mjs';

const toolRoot = fileURLToPath(new URL('../', import.meta.url));
export async function generatorFingerprint(root = toolRoot) {
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const paths = ['package.json', 'schemas/atlas.schema.json'];
  for (const entry of await readdir(resolve(root, 'scripts'), { withFileTypes: true })) if (entry.isFile() && entry.name.endsWith('.mjs')) paths.push(`scripts/${entry.name}`);
  for (const directory of ['assets/report', 'assets/report/vendor']) {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) if (entry.isFile()) paths.push(`${directory}/${entry.name}`);
  }
  const hashes = await Promise.all(paths.sort().map(async path => [path, await hashFile(resolve(root, path))]));
  return { name: pkg.name, version: pkg.version, sha256: hashText(JSON.stringify(hashes)) };
}

export function embeddedReportData(html) {
  const match = html.match(/<script id="graph-data" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) throw new Error('Report has no embedded graph-data');
  return JSON.parse(match[1]);
}

export function bindPublishedManifest(html, raw) {
  const data = embeddedReportData(html);
  data.fingerprint.manifestSha256 = hashText(raw);
  const json = JSON.stringify(data).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
  return html.replace(/(<script id="graph-data" type="application\/json">)[\s\S]*?(<\/script>)/, (_, start, end) => start + json + end);
}

// Read-only freshness check: compare current inputs, never repair by rebuilding.
export async function checkReportFreshness(manifestPath) {
  const bundle = await loadManifest(manifestPath);
  const reportPath = assertOutputInside(bundle.workspace, bundle.manifest.output);
  let html;
  try { html = await readFile(reportPath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { manifest: bundle.manifestPath, report: reportPath, fresh: false, reasons: ['report-missing'] }; throw error; }
  let fingerprint;
  try { fingerprint = embeddedReportData(html).fingerprint; }
  catch { return { manifest: bundle.manifestPath, report: reportPath, fresh: false, reasons: ['report-invalid'] }; }
  const generator = await generatorFingerprint();
  const inventory = await collectFileInventory({ manifest: bundle.manifest, workspace: bundle.workspace, allowMissingSources: true });
  const expected = {
    toolVersion: generator.version, toolSha256: generator.sha256,
    manifestSha256: hashText(bundle.raw), analysisManifestSha256: analysisManifestHash(bundle.manifest),
    sourceSha256: inventoryHash(inventory)
  };
  const reasons = Object.keys(expected).filter(key => fingerprint?.[key] !== expected[key]);
  if (fingerprint?.reviewMode) reasons.push('review-preview');
  return { manifest: bundle.manifestPath, report: reportPath, fresh: !reasons.length, reasons, fingerprint };
}
