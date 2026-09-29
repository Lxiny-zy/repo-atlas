import { execFileSync } from 'node:child_process';
import { resolve, relative } from 'node:path';
import { hashBytes } from './evidence-lib.mjs';
import { realpathSync } from 'node:fs';
import { inside } from './io-lib.mjs';

const gitArgs = ['--no-optional-locks'];
export function gitInfo(workspace) {
  const git = args => execFileSync('git', [...gitArgs, ...args], { cwd: workspace, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 }).trim();
  try {
    return { available: true, commit: git(['rev-parse', 'HEAD']), shortCommit: git(['rev-parse', '--short=12', 'HEAD']), branch: git(['branch', '--show-current']) || '(detached HEAD)', dirty: Boolean(git(['status', '--porcelain'])), treeHash: git(['rev-parse', 'HEAD^{tree}']), prefix: git(['rev-parse', '--show-prefix']) };
  } catch (error) {
    return { available: false, commit: null, shortCommit: null, branch: null, dirty: null, treeHash: null, prefix: '', reason: error.code === 'ENOENT' ? 'git-not-installed' : 'git-metadata-unavailable' };
  }
}

// Read each repository's historic blobs in bounded batches, then verify against
// the actual snapshot hash. A dirty snapshot must never silently become HEAD.
export function baselineTexts(workspace, baseline, paths, { maxBytes = 16 * 1024 * 1024 } = {}) {
  const result = new Map();
  const repos = baseline.repositories || { '.': { path: '.', git: baseline.git } };
  const batches = new Map();
  let plannedBytes = 0;
  for (const path of new Set(paths)) {
    const record = baseline.files?.[path];
    if (!record) { result.set(path, { text: null, reason: 'not-in-baseline' }); continue; }
    const repo = repos[record.repository ?? '.'];
    try {
      const root = realpathSync(resolve(workspace, repo?.path || '.'));
      if (!inside(workspace, root) || !inside(root, resolve(workspace, path))) throw new Error('outside repository');
    } catch {
      result.set(path, { text: null, reason: 'historic-repository-unavailable' }); continue;
    }
    const commit = repo?.git?.commit;
    if (!commit || !/^[a-f0-9]{40,64}$/.test(commit) || /[\r\n]/.test(path)) { result.set(path, { text: null, reason: 'git-history-unavailable' }); continue; }
    if (record.size > 8 * 1024 * 1024) { result.set(path, { text: null, reason: 'historic-file-too-large' }); continue; }
    if (plannedBytes + record.size > maxBytes) { result.set(path, { text: null, reason: 'historic-read-budget' }); continue; }
    plannedBytes += record.size;
    const local = relative(resolve(workspace, repo.path), resolve(workspace, path)).replaceAll('\\', '/');
    const key = repo.path;
    if (!batches.has(key)) batches.set(key, { repo, items: [] });
    batches.get(key).items.push({ path, record, spec: `${commit}:${repo.git.prefix || ''}${local}` });
  }
  for (const { repo, items } of batches.values()) {
    while (items.length) {
      const chunk = []; let size = 0;
      while (items.length && chunk.length < 50 && (size + items[0].record.size < 12 * 1024 * 1024 || !chunk.length)) { const item = items.shift(); chunk.push(item); size += item.record.size; }
      try {
        const output = execFileSync('git', [...gitArgs, 'cat-file', '--batch'], { cwd: resolve(workspace, repo.path), input: chunk.map(item => item.spec + '\n').join(''), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
        let offset = 0;
        for (const item of chunk) {
          const end = output.indexOf(10, offset);
          if (end < 0) throw new Error('invalid git batch response');
          const header = output.subarray(offset, end).toString('utf8'); offset = end + 1;
          const match = header.match(/^[a-f0-9]+ blob (\d+)$/);
          if (!match) { result.set(item.path, { text: null, reason: 'historic-blob-unavailable' }); continue; }
          const length = Number(match[1]); const bytes = output.subarray(offset, offset + length); offset += length + 1;
          result.set(item.path, hashBytes(bytes) === item.record.sha256 ? { text: bytes.toString('utf8'), reason: null } : { text: null, reason: 'snapshot-content-differs-from-commit' });
        }
      } catch {
        for (const item of chunk) result.set(item.path, { text: null, reason: 'git-batch-read-failed' });
      }
    }
  }
  return result;
}

export function textDiff(before, after, path) {
  if (before === after) return '';
  const a = before ? before.split('\n') : [], b = after ? after.split('\n') : [];
  let start = 0, suffix = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (suffix < a.length - start && suffix < b.length - start && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
  const from = Math.max(0, start - 4), keep = Math.min(4, suffix);
  const oldEnd = a.length - suffix, newEnd = b.length - suffix;
  return [`--- a/${path}`, `+++ b/${path}`, `@@ -${a.length ? from + 1 : 0},${oldEnd + keep - from} +${b.length ? from + 1 : 0},${newEnd + keep - from} @@`, ...a.slice(from, start).map(line => ' ' + line), ...a.slice(start, oldEnd).map(line => '-' + line), ...b.slice(start, newEnd).map(line => '+' + line), ...a.slice(oldEnd, oldEnd + keep).map(line => ' ' + line)].join('\n');
}
