// Synthetic browser fixture only: these decisions are never applied to a user's project.
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, process.argv[2] || 'tmp-review-workflow');
if (!output.startsWith(resolve(root, 'tmp-'))) throw new Error('Fixture output must use a tmp- directory inside this repository');
await mkdir(output); // Refuse to overwrite an earlier fixture or its reviews.
const run = (dir, script, ...args) => execFileSync(process.execPath, [resolve(root, 'scripts', script), ...args], { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
for (const name of ['accepted', 'unresolved']) {
  const dir = resolve(output, name);
  await cp(resolve(root, 'tests/fixtures/multi-chain'), dir, { recursive: true });
  run(dir, 'snapshot.mjs', 'atlas.json');
  const path = resolve(dir, 'src/order.js');
  if (name === 'unresolved') await rm(path);
  else await writeFile(path, (await readFile(path, 'utf8')).replace('valid: true', 'valid: false'));
  run(dir, 'delta.mjs', 'atlas.json'); run(dir, 'refresh.mjs', 'atlas.json');
  if (name === 'unresolved') run(dir, 'build.mjs', 'atlas.next.json', '--review');
  else {
    run(dir, 'review.mjs', 'atlas.next.json');
    const reviewPath = resolve(dir, '.repo-atlas/review.json');
    const review = JSON.parse(await readFile(reviewPath, 'utf8'));
    review.reviewer = 'Synthetic fixture reviewer'; review.reviewedAt = new Date().toISOString();
    for (const item of review.items) { item.decision = 'approved'; item.note = 'Synthetic fixture approval for browser regression only.'; }
    await writeFile(reviewPath, JSON.stringify(review, null, 2));
    run(dir, 'accept.mjs', 'atlas.next.json', '--review', '.repo-atlas/review.json', '--output-dir', '.repo-atlas/accepted/fixture');
  }
}
console.log(JSON.stringify({ output }, null, 2));
