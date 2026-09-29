import { realpathSync, lstatSync, statSync } from 'node:fs';
import { mkdir, open, rename, link, unlink } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, sep, extname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const inside = (root, path) => { const rel = relative(root, path); return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)); };
export function assertOutputInside(workspace, value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('A nonempty workspace output path is required');
  const full = resolve(workspace, value);
  if (!inside(workspace, full)) throw new Error('Output escapes workspace');
  let ancestor = full;
  for (;;) {
    try {
      const info = lstatSync(ancestor);
      if (info.isSymbolicLink() && ancestor === full) throw new Error('Output/input file must not be a symbolic link');
      if (!inside(workspace, realpathSync(ancestor))) throw new Error('Output ancestor escapes workspace');
      return full;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (dirname(ancestor) === ancestor) throw error;
      ancestor = dirname(ancestor);
    }
  }
}

const identity = path => { try { return statSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const canonicalDestination = path => {
  let ancestor = resolve(path);
  for (;;) {
    try { return resolve(realpathSync(ancestor), relative(ancestor, resolve(path))); }
    catch (error) { if (error.code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error; ancestor = dirname(ancestor); }
  }
};
export function sameFile(left, right) {
  if (relative(canonicalDestination(left), canonicalDestination(right)) === '') return true;
  const a = identity(left), b = identity(right);
  return Boolean(a && b && a.ino && b.ino && a.dev === b.dev && a.ino === b.ino);
}
export function planOutput(workspace, value, { protectedPaths = [], extension = '.json', replace = true } = {}) {
  const full = assertOutputInside(workspace, value);
  if (extname(full).toLowerCase() !== extension) throw new Error(`Output must use ${extension}`);
  const canonical = canonicalDestination(full), outputInfo = identity(full);
  if (protectedPaths.some(path => {
    if (relative(canonical, canonicalDestination(path)) === '') return true;
    if (!outputInfo?.ino) return false;
    const inputInfo = identity(path);
    return inputInfo?.ino && outputInfo.dev === inputInfo.dev && outputInfo.ino === inputInfo.ino;
  })) throw new Error('Output would overwrite an input or another output');
  if (outputInfo?.isDirectory()) throw new Error('Output must be a file');
  if (!replace && outputInfo) throw new Error('Output already exists. Use --replace to update it.');
  return full;
}

export async function atomicWrite(workspace, output, text, options = {}) {
  const full = planOutput(workspace, output, options);
  await mkdir(dirname(full), { recursive: true });
  assertOutputInside(workspace, full);
  const temporary = resolve(dirname(full), `.repo-atlas-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(text, 'utf8'); await handle.sync(); await handle.close(); handle = null;
    planOutput(workspace, full, options);
    if (options.replace === false) { await link(temporary, full); await unlink(temporary); }
    else await rename(temporary, full);
  } finally {
    if (handle) await handle.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
