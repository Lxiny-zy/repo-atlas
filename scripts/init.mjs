import { readFile, realpath } from 'node:fs/promises';
import { resolve, dirname, relative, extname, basename } from 'node:path';
import { parseOptions } from './cli-lib.mjs';
import { checkedPath, writeJson } from './snapshot-lib.mjs';
import { assertManifest } from './manifest-lib.mjs';
import { planOutput, atomicWrite } from './io-lib.mjs';
import { hashText } from './evidence-lib.mjs';

const options = parseOptions(process.argv.slice(2), {
  value: ['source', 'output', 'title'], required: ['source'],
  usage: 'Usage: node scripts/init.mjs <workspace> --source src/entry.js [--output docs/architecture/atlas.json] [--title Project]'
});
const workspace = await realpath(resolve(options._[0]));
const sourcePath = await checkedPath(workspace, options.source);
const path = relative(workspace, sourcePath).replaceAll('\\', '/');
const output = planOutput(workspace, options.output || 'docs/architecture/atlas.json', { protectedPaths: [sourcePath], replace: false });
const lines = (await readFile(sourcePath, 'utf8')).split(/\r?\n/);
const index = lines.findIndex(line => line.trim());
if (index < 0 || lines[index].length > 500) throw new Error('Choose a nonempty text source with readable lines');
const length = Math.min(8, lines.length - index);
const source = { id: 'entry', path, match: lines[index], occurrence: 1, length, excerptSha256: hashText(lines.slice(index, index + length).join('\n')) };
const manifest = {
  manifestVersion: 1,
  workspace: relative(dirname(output), workspace).replaceAll('\\', '/') || '.',
  output: relative(workspace, resolve(dirname(output), 'report.html')).replaceAll('\\', '/'),
  project: { title: options.title || basename(workspace), scope: `初始取证文件：${path}`, boundary: '初始化模板；尚未分析模块职责、业务行为和运行环境。' },
  modules: [{ id: 'entry', name: '待分析入口', summary: '请阅读源码后填写职责与输入输出。', facts: [], paths: [path], sources: [source] }],
  views: [{ id: 'overview', title: '项目分析起点', kind: 'narrative', modules: ['entry'], notes: [['待完成', '阅读源码、确认边界，并补充业务关系与覆盖状态。']] }],
  coverage: [{ id: 'scope', area: '分析范围', summary: '仅定位初始源码，业务含义尚未核对。', status: 'unknown', nextCheck: `从 ${path} 追踪入口与必要上下游。`, modules: ['entry'] }],
  fileGroups: extname(path) ? [{ name: 'Initial source', paths: [path], extensions: [extname(path)] }] : []
};
assertManifest(manifest);
await atomicWrite(workspace, output, writeJson(manifest), { protectedPaths: [sourcePath], replace: false });
console.log(writeJson({ output, status: 'scaffold', next: ['doctor.mjs', 'read source and author conclusions', 'validate.mjs', 'build.mjs'] }));
