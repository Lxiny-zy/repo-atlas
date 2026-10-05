# 2026-09-29 清单 Schema 与批量诊断交付

本轮完成此前剩余清单中的 JSON Schema、编辑器辅助和批量结构化诊断。所有变更保留在本地工作区，尚未提交或推送。

## 已交付

- [atlas.schema.json](../../../schemas/atlas.schema.json)：draft 2020-12 契约，覆盖可编辑字段、证据长度/次数、状态、条件必填项和未知字段检查；[最小示例](../../../schemas/atlas.example.json) 可直接针对仓库夹具验证。
- [.vscode/settings.json](../../../.vscode/settings.json)：为 `atlas.json` / `atlas.next.json` 关联本地 Schema。
- [validate.mjs](../../../scripts/validate.mjs)：只读批量检查，支持 JSON 输出、结构检查和复核模式；一个文件失败后继续处理其他文件。错误定位使用 JSON Pointer，重复 ID 指向首次定义。
- [manifest-lib.mjs](../../../scripts/manifest-lib.mjs)：共享结构与引用预检，已接入 build 和所有通过 loadManifest 读取清单的增量/复核命令；独立验证还汇总源码锚点、路径与显式输出冲突。
- [schema-lib.mjs](../../../scripts/schema-lib.mjs)：无运行依赖的随附 Schema 执行器，不实现完整通用 JSON Schema；不支持的关键字在启动时报错。
- refresh / accept 移动清单时重写相对 `$schema`，保持编辑器链接目标；该字段不改变语义哈希。修正阶段 ID 拼接校验问题，链路和阶段各自可使用 64 字符 ID。

## 使用

```text
node scripts/validate.mjs schemas/atlas.example.json
node scripts/validate.mjs first/atlas.json second/atlas.json --json
node scripts/validate.mjs atlas.json --structure-only
node scripts/validate.mjs atlas.next.json --review
```

退出码：0 为本次检查无错误，1 为校验错误，2 为参数错误。复核模式中的警告不代表可被 accept 接受。命令不写入清单或报告，不回显源码或无效 JSON 原文。

可选字段应省略，不传 `null`；`flags[].value` 可为任意 JSON 值。未支持的字段会报错，以捕获拼写错误。无 `$schema` 的既有合法清单继续可用。

检查边界：不递归重建文件索引，不检查 Git 状态、Mermaid 渲染、审核绑定或业务结论；正式构建与增量/接受流程仍执行各自的必要检查。`update` / `review` 的内部契约由工作流验证。

## 实测结果

环境为本机 Windows、Node v24.11.1；下列均已实际执行：

| 验证 | 结果 |
|---|---|
| `npm test` | 35 项通过：18 项增量、10 项清单、7 项复核；原有端到端夹具通过 |
| Schema 标准性与执行器对照 | Ajv 8.17.1 接受 draft 2020-12 Schema；6,680 个合法/非法配置比较案例一致 |
| 编辑器语言服务 | vscode-json-languageservice 5.6.4：文件关联、有效配置、未知字段、条件证据约束、根字段与模块/运行期字段补全通过；无远程 Schema 请求 |
| 完整批量验证 | 最小示例、原始夹具、中文项目清单、已接受合成版本共 4 份通过 |
| 更新后的中文报告 | 正式构建成功；10 模块、3 链路、30 处证据；Playwright 1.58.2 / Chromium 交互与 320/390px 布局通过 |
| Git 空白检查 | 通过 |

关键回归还覆盖：多错误同时报告、未知引用、重复证据 ID、缺失/歧义锚点、JSON 解析失败后继续批处理、脱敏、路径穿越和目录链接越界、输出碰撞、预检失败不写文件，以及正式构建失败清理暂存目录。

编辑器测试使用 VS Code 的 JSON 语言服务，无人工编辑器界面验收；本轮只重跑了更新报告的 Chromium，前一轮 Firefox/WebKit 结果仍属于前一版报告。远程 CI 未触发，新增 Ajv 检查已加入现有 Windows/Linux、Node 18/22/24 配置。

可复验入口：

- [独立 Schema 对照脚本](../../../scripts/verify-schema.mjs)：`node scripts/verify-schema.mjs --ajv tmp-schema-validation/node_modules/ajv/dist/2020.js`。
- [编辑器探针](../../../tmp-schema-editor/probe.mjs) 与[实测结果](../../../tmp-schema-editor/result.json)，测试依赖仅位于临时目录。
- [最新中文报告](../../../tmp-frontend-optimized/report.html) 与 [Chromium 结果](../../../tmp-frontend-optimized/report.verification/chromium/result.json)。
- [批量诊断样本及摘要](2026-09-29-validation-results.json)。

## 剩余本地任务

1. 50,000 文件、多证据、密集图表、多仓库 Git 的重复性能统计，以及浏览器搜索、渲染和内存预算。
2. 独立关系证据模型，让模块间每条关系可以绑定、复核和追踪源码依据。

远程 CI 实际执行及真实 Safari/iPhone 验收另需相应环境，不属于本轮完成范围。
