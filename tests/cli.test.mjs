import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, UsageError } from '../scripts/cli-lib.mjs';

test('CLI boolean flags do not consume paths; values preserve equals and -- terminates options', () => {
  const specification = { boolean: ['json'], value: ['output'], min: 2 };
  const parsed = parseArgs(['--json', 'base.json', '--output=a=b.json', '--', '--head.json'], specification);
  assert.deepEqual(parsed._, ['base.json', '--head.json']);
  assert.equal(parsed.json, true);
  assert.equal(parsed.output, 'a=b.json');
});

test('CLI rejects unknown, duplicate, missing, extra and incorrectly typed arguments', () => {
  const specification = { boolean: ['json'], value: ['output'], required: ['output'] };
  for (const args of [
    ['file.json', '--typo'], ['file.json', '--output'], ['file.json', '--output='],
    ['file.json', '--output', '--json'], ['file.json', '--json=false'],
    ['file.json', '--output=a', '--output=b'], ['file.json'],
    ['file.json', 'extra.json', '--output=a'], ['--output=a'], ['file.json', '-x']
  ]) assert.throws(() => parseArgs(args, specification), UsageError);
  assert.equal(parseArgs(['--help'], specification).help, true);
});

test('public CLI help and invalid options exit before filesystem or browser work', () => {
  for (const script of ['build', 'validate', 'snapshot', 'delta', 'context', 'refresh', 'review', 'accept', 'compare', 'check-delivery', 'verify', 'benchmark']) {
    const file = fileURLToPath(new URL(`../scripts/${script}.mjs`, import.meta.url));
    const invoke = (...args) => spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', windowsHide: true });
    const help = invoke('--help');
    assert.equal(help.status, 0, `${script}: ${help.stderr}`);
    assert.match(help.stdout, /^Usage:/);
    assert.equal(help.stderr, '');
    const invalid = invoke('--not-a-supported-option');
    assert.equal(invalid.status, 2, script);
    assert.match(invalid.stderr, /Unknown option/);
    assert.doesNotMatch(invalid.stderr, /ENOENT|at file:|not installed/);
  }
});
