# 2026-09-29 复核、定位链接与浏览器交付

本轮补齐前一轮列出的复核工作流、阶段/证据深链接和浏览器引擎验证。变更保留在本地工作区，未提交或发布到远程。

## 当前交付

- [review.mjs](../../scripts/review.mjs) 生成与候选、源码、基线及 delta 绑定的复核单。审核人填写身份、时间和逐项决定/说明；已有复核单不会被覆盖。
- [accept.mjs](../../scripts/accept.mjs) 校验完整任务集合、任务描述、指纹、明确批准和版本一致性，执行严格构建，再整体发布新的版本目录。报告、清单、快照及逐项回执均保留；构建失败时清理暂存目录。原清单、基线和已有版本不被替换。
- `build --review` 支持缺失/歧义证据预览。报告显示“仅供复核”、未解析原因；对应 covered/partial 阶段降为 unknown、confirmed 发现项降为 unverified，原声明另存。不会生成假的摘录和行号，也不会放宽路径边界。未解析证据不能通过正式接受。
- 视图、链路、阶段及证据可复制定位链接。URL 片段支持直接进入、高亮阶段、证据返回、浏览器历史，以及无效或不一致目标提示。证据 source.id 可保持数组重排后的链接身份。
- [verify.mjs](../../scripts/verify.mjs) 支持 Chromium、Firefox、WebKit，区分普通报告、复核预览和已审核版本；[CI](../../.github/workflows/ci.yml) 扩充了引擎矩阵及三种报告的检查。

详细使用步骤见 [README](../../README.md) 与[复核契约](../../references/manifest-format.md)。复核记录提供本地声明和版本校验，不提供身份认证或数字签名。

## 验证结果

本机 Windows / Node v24.11.1，固定 Playwright 1.58.2：

| 检查 | 结果 |
|---|---|
| 增量和复核回归 | 24 项通过 |
| 原有端到端流程 | 通过 |
| 基础报告 | Chromium / Firefox / WebKit 通过 |
| 中文项目预览 | Chromium / Firefox / WebKit 通过 |
| 已审核合成版本 | Chromium / Firefox / WebKit 通过 |
| 缺失证据预览 | Chromium / Firefox / WebKit 通过 |
| JS 语法及 Git diff 空白检查 | 通过 |

普通报告覆盖图表、搜索、证据、导出、全屏、分页、深链接、弹窗返回和 320/390px 布局。已审核版本额外检查复核人及接受版本展示；复核预览检查明确标识、未解析占位与移动端布局。浏览器没有页面错误或外部 HTTP 请求。

Windows WebKit 在导航前启用 Playwright 离线模拟会内部报错。本轮定位后采用实际 file:// 页面加载，全程阻断 HTTP 请求，加载后再启用离线模拟。结果中 `documentTransport: file` 和 `offlineEmulation` 明确记录此顺序。Firefox 的移动检查使用窄视口与触摸配置，不使用其不支持的 isMobile。以上均不等于真实 Safari/iPhone 设备验收。

审核通过样本仅来自 `prepare-review-fixture.mjs` 的合成夹具；没有替用户或他人填写真实项目的审核结论。

## 本地查看

- [中文项目预览](../../tmp-frontend-optimized/report.html)，已加入复核与接受模块及源码依据。
- [已审核版本示例](../../tmp-review-workflow-20260929/accepted/.repo-atlas/accepted/fixture/report.html)。
- [缺失证据复核预览](../../tmp-review-workflow-20260929/unresolved/report.html)。
- [浏览器结果汇总](2026-09-29-browser-results.json)。完整截图及结果位于各报告旁的 `report.verification/<browser>/` 目录。

这些 tmp 文件为本地可复验产物，不纳入正式源码。

## 尚未覆盖的扩展

编辑器 JSON Schema 与批量结构化诊断已在[后续交付](2026-09-29-schema-and-validation-delivery.md)完成。关系证据模型、50,000 文件及大量证据/密集图表的重复性能统计仍待推进。远程 Linux/Node CI 配置尚未实际触发，真实 Safari/iPhone 环境尚未验收。这些不影响已完成的本地复核、版本接受和深链接流程。
