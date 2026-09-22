import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, match => match.slice(1)));
const repoRoot = resolve(here, '..');
const fixture = resolve(repoRoot, 'tests/fixtures/multi-chain');
const run = (cwd, script, ...args) => execFileSync(process.execPath, [resolve(repoRoot, 'scripts', script), ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=repo-atlas-test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const workspace = await mkdtemp(resolve(tmpdir(), 'repo-atlas-test-'));
try {
  await cp(fixture, workspace, { recursive: true });
  git(workspace, 'init', '--quiet');
  git(workspace, 'add', '.');
  git(workspace, 'commit', '--quiet', '-m', 'fixture');
  run(workspace, 'snapshot.mjs', 'atlas.json');

  const sourcePath = resolve(workspace, 'src/order.js');
  await writeFile(sourcePath, `${await readFile(sourcePath, 'utf8')}\nexport const revision = 2;\n`, 'utf8');
  run(workspace, 'delta.mjs', 'atlas.json');
  run(workspace, 'context.mjs', 'atlas.json', '--changed-only');
  run(workspace, 'context.mjs', 'atlas.json', '--stale-only', '--out', '.repo-atlas/stale-context.json');
  run(workspace, 'build.mjs', 'atlas.json');

  const delta = JSON.parse(await readFile(resolve(workspace, '.repo-atlas/delta.json'), 'utf8'));
  const context = JSON.parse(await readFile(resolve(workspace, '.repo-atlas/context.json'), 'utf8'));
  const staleContext = JSON.parse(await readFile(resolve(workspace, '.repo-atlas/stale-context.json'), 'utf8'));
  assert.equal(delta.summary.changedFiles, 1);
  assert.ok(delta.impacted.includes('chain:create_order'));
  assert.equal(context.changedFiles.length, 1);
  assert.ok(context.entities.some(entity => entity.key === 'chain:create_order'));
  assert.ok(context.evidence.some(item => item.current && item.previous));
  assert.ok(context.relationships.impactedModules.some(module => module.id === 'api'));
  assert.ok(context.evidence.some(item => item.current?.text.includes('[REDACTED]') && !item.current.text.includes('fixture-secret')));
  assert.ok(context.entities.some(entity => entity.previousSummary));
  assert.ok(staleContext.entities.length > 0);
  assert.ok(staleContext.entities.every(entity => entity.stale));
  console.log(JSON.stringify({ ok: true, changedFiles: context.changedFiles.length, entities: context.entities.length, evidence: context.evidence.length }, null, 2));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
