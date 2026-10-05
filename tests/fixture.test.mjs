import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { copyFixture } from '../scripts/fixture-lib.mjs';

test('fixture preparation excludes existing reports, reviews and browser artifacts', async t => {
  const dir = await mkdtemp(resolve(tmpdir(), 'atlas-fixture-copy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = resolve(dir, 'source');
  for (const name of ['src', '.repo-atlas', 'report.verification']) await mkdir(resolve(source, name), { recursive: true });
  await writeFile(resolve(source, 'atlas.json'), '{}');
  await writeFile(resolve(source, 'src/example.js'), 'export const value = 1;');
  await writeFile(resolve(source, 'report.html'), 'old generated report');
  await writeFile(resolve(source, '.repo-atlas/review.json'), 'old review');
  const destination = resolve(dir, 'copy');
  await copyFixture(destination, source);
  assert.deepEqual((await readdir(destination)).sort(), ['atlas.json', 'src']);
  assert.equal(await readFile(resolve(destination, 'src/example.js'), 'utf8'), 'export const value = 1;');
});
