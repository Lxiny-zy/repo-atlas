import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve, extname } from 'node:path';
import { hashBytes, hashText } from './evidence-lib.mjs';
import { planOutput, atomicWrite, assertOutputInside } from './io-lib.mjs';

export const relativeUrl = (from, to) => relative(dirname(from), to).replaceAll('\\', '/').split('/').map(encodeURIComponent).join('/');

// Immutable content-addressed directories let several reports share local
// assets without a new build silently changing an older report's rendering.
export async function publishFiles(workspace, directory, files, protectedPaths = []) {
  const version = hashText(JSON.stringify(files.map(file => [file.path, hashBytes(file.bytes)]))).slice(0, 24);
  const root = assertOutputInside(workspace, resolve(directory, version));
  const plans = [];
  for (const file of files) {
    const output = planOutput(workspace, resolve(root, file.path), { extension: extname(file.path), protectedPaths });
    let existing;
    try { existing = await readFile(output); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing && hashBytes(existing) !== hashBytes(file.bytes)) throw new Error('An immutable report bundle was modified; choose another directory');
    plans.push({ ...file, output, exists: Boolean(existing) });
  }
  for (const file of plans) if (!file.exists) await atomicWrite(workspace, file.output, file.bytes, { extension: extname(file.path), protectedPaths, replace: false });
  return { root, files: plans.map(file => file.output) };
}
