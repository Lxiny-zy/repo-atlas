import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const walk = async directory => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
};
const sources = [...await walk(resolve(root, 'scripts')), ...await walk(resolve(root, 'tests')), ...await walk(resolve(root, 'examples')), resolve(root, 'assets/report/app.js')]
  .filter(path => ['.mjs', '.js'].includes(extname(path))).sort();
let failures = 0;
for (const path of sources) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) { failures++; console.error(result.stderr || result.error?.message || `Syntax check failed: ${path}`); }
}
const documents = ['README.md', 'SKILL.md', '.github/CONTRIBUTING.md', '.github/CODE_OF_CONDUCT.md', '.github/SECURITY.md'];
documents.push(...(await walk(resolve(root, 'docs'))).filter(path => extname(path) === '.md'));
let links = 0;
for (const file of documents) {
  const path = resolve(root, file);
  // Only inline file links are checked; remote links and heading fragments are
  // deliberately excluded so this check stays offline and deterministic.
  const text = (await readFile(path, 'utf8')).replace(/^```[^\n]*\n[\s\S]*?^```/gm, '');
  for (const match of text.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
    const target = match[1].replace(/^<(.+)>$/, '$1').split('#')[0];
    if (!target || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
    links++;
    try { await stat(resolve(dirname(path), decodeURIComponent(target))); }
    catch { failures++; console.error(`Broken local link: ${file} -> ${target}`); }
  }
}
console.log(`${sources.length} JavaScript files; ${links} local documentation links; ${failures} failures`);
process.exitCode = failures ? 1 : 0;
