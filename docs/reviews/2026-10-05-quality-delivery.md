# repo-atlas 质量优化交付记录

日期：2026-10-05。此次改动已在本地工作区完成，未创建提交、推送或发布新版本。

## 结果

本轮完成了正确性修复、命令行统一、目录读取优化、测试隔离、开发依赖治理和开源文档整理。项目保持无 npm 运行时依赖、单文件离线报告及显式复核的原有定位。

最终本地验证：**46 项测试通过，端到端夹具通过；6680 组 Schema 对照通过；3 种浏览器 × 3 种报告模式全部通过；npm audit 为 0 项漏洞。**

这些结果说明本轮改动经过具体检查，不代表项目已经没有缺陷，也不替代远端 CI、真实项目业务复核或设备验收。

## 实现改动

| 改动 | 用户可见结果 | 主要位置 |
|---|---|---|
| 修复语义比较漏报 | `flags[].value` 中的 output、workspace、update、review、freshness 及嵌套/特殊 JSON 键完整参与比较 | `scripts/compare.mjs` |
| 保护比较输入 | 输出不能覆盖任一输入及其硬链接别名；限制输出范围，已有结果必须明确替换，写入为原子操作 | `scripts/compare.mjs`、共享 io-lib |
| 统一 CLI | 布尔参数不再吞掉文件名，支持前后放置、等号值、`--` 和帮助；未知/重复/缺值及错误数量在执行前拒绝 | `scripts/cli-lib.mjs` 及 12 个用户命令 |
| 加强交付检查 | 检查真实文件字节、绑定格式和链接越界；缺失源码摘要不能通过 | `scripts/check-delivery.mjs` |
| 缓存目录读取 | 重叠分组复用路径、stat 和目录枚举，仍分别应用过滤规则与访问集合；每次快照重新建立缓存 | `scripts/snapshot-lib.mjs` |
| 自动发现测试 | 新增 `*.test.mjs` 自动纳入，避免人工维护固定测试列表，兼容 Windows 不展开 shell glob 的情况 | `scripts/run-tests.mjs` |
| 隔离测试夹具 | 只复制 atlas.json 和 src，不带入旧 HTML、复核状态或浏览器截图 | `scripts/fixture-lib.mjs` |
| 消除浏览器测试竞态 | focus 链接等待详情实际可见，避免旧的 selectedModule 提前满足断言前置条件 | `scripts/verify.mjs` |
| 扩展规模基准 | 支持重复样本、额外证据、重叠分组和本地 Git 基线，保留原始样本及中位数/p95 | `scripts/benchmark.mjs` |

正常测试与额外边界验证覆盖：字段语义、硬链接、越界目录联接、输入不变性、覆盖策略、CLI 行为、分组排除规则、缓存刷新、交付绑定和夹具污染。浏览器检查仍保留原有交互断言，没有用跳过测试或固定延时掩盖失败。

## 文档与开源维护

- 重写 [中文 README](../../README.md)，新增独立 [英文 README](../../README.en.md)，两者包含可直接运行的示例、完整增量复核路径、路径基准与产品边界。
- 新增 [CLI 参考](../cli.md) 和 [开发架构说明](../architecture.md)，同步 SKILL 与 CHANGELOG。
- 扩充 CONTRIBUTING 和 SECURITY，提供实际安装/验证命令、兼容性约束与可用的私密报告路径说明；没有编造安全邮箱、维护 SLA 或版本支持承诺。
- 新增 Issue 表单、PR 模板、EditorConfig、Git 换行策略和 Dependabot 配置。
- 开发依赖固定为 Ajv 8.20.0、Playwright 1.58.2，提交 npm v3 锁文件，CI 使用 `npm ci`；生成器仍不依赖这两个包。
- 新增 `npm run check`，检查一方 JavaScript 语法和维护中文档的本地文件链接。它不访问远端，也不检查标题片段；历史评估记录不属于持续链接门禁范围。
- CI 增加缓存、任务超时、旧运行取消和 14 天浏览器产物保留；现有系统/Node/浏览器矩阵保留。

Ajv 旧开发版本位于 GHSA-2g4f-4pwh-qvx6 的受影响范围，本轮更新到修复范围并重新完成独立 Schema 对照。npm audit 的零结果针对当前 npm 依赖图，不包含对内嵌第三方浏览器资源的专项漏洞审计。

## 性能证据与权衡

同一台 Windows 主机、Node v24.11.1；同一工作负载：1000 个文件、112 条证据、4 个重叠分组、Git 基线、1% 文件变化，每组 2 次采样。优化前后均使用本轮扩展后的同一个基准脚本，仅目录读取缓存不同。

```sh
node scripts/benchmark.mjs --scales 1000 --samples 2 --groups 4 --extra-evidence 100 --git
```

| 指标 | 缓存前中位数 | 缓存后中位数 | 观察 |
|---|---:|---:|---|
| 冷快照 | 1822 ms | 840.5 ms | 约缩短 54% |
| 热快照 | 1258.5 ms | 770 ms | 约缩短 39% |
| 增量差异 | 1975.5 ms | 1456 ms | 约缩短 26% |
| 增量上下文 | 2132.5 ms | 1606.5 ms | 约缩短 25% |
| 构建 | 1699 ms | 1786.5 ms | 没有证明提速 |

报告字节数和上下文字节数在该场景前后相同，分别为 3941117 和 23106，均未截断上下文。

原始耗时样本（单位 ms）：

| 阶段 | 冷快照 | 热快照 | build | delta | context | 采样峰值 RSS MiB |
|---|---|---|---|---|---|---|
| 前，样本 1 | 1854 | 1187 | 1699 | 2005 | 2145 | 86 |
| 前，样本 2 | 1790 | 1330 | 1699 | 1946 | 2120 | 90 |
| 后，样本 1 | 882 | 757 | 1637 | 1452 | 1587 | 87 |
| 后，样本 2 | 799 | 783 | 1936 | 1460 | 1626 | 125 |

缓存以额外进程内存换取更少的重复 I/O。采样峰值有上升，但 RSS 受 GC、顺序和操作系统缓存影响，不能把全部差值都归因于新增缓存。缓存只活到单次 inventory 完成，不跨快照保存。两次样本不足以证明稳定的尾延迟，也不能外推到所有真实仓库或前端性能。

## 最终验证记录

| 检查 | 实际结果 |
|---|---|
| `npm ci --ignore-scripts` | 锁文件安装成功；测试工具均已可用 |
| `npm run check` | 36 个 JavaScript 文件、53 个本地文档链接，0 失败 |
| `npm test` | 46 通过、0 失败、0 跳过；随后端到端回归 `ok: true` |
| `npm run verify:schema` 对应脚本 | 6680 组比较，schemaValid/valid 均为 true |
| README 最小示例 validate/build | 通过，生成 example-report.html |
| 多链路示例与复核夹具 | 构建成功，独立生成未解析预览及接受版本 |
| Chromium | 普通 / 复核预览 / 已接受：3/3 通过 |
| Firefox | 普通 / 复核预览 / 已接受：3/3 通过 |
| WebKit | 普通 / 复核预览 / 已接受：3/3 通过 |
| GitHub YAML | 4 个文件解析成功；不等同远端 Actions 执行 |
| `git diff --check` | 通过 |
| `npm audit --json` | 0 项漏洞 |

浏览器使用锁定的 Playwright 1.58.2 和本机匹配引擎，最终各组 errors 均为空。检查涉及导航、缩放/拖动、关系链接、证据弹窗、检索、导出、移动宽度、分页及离线请求约束。Windows WebKit 的离线模拟仍采用“先加载本地文件、全程阻断 HTTP，再启用 offline”，结果明确记录该差异。

本地浏览器结果与截图保留在忽略目录：

- `tests/fixtures/multi-chain/report.verification/<browser>/`
- `tmp-review-quality-final/unresolved/report.verification/<browser>/`
- `tmp-review-quality-final/accepted/.repo-atlas/accepted/fixture/report.verification/<browser>/`

## 兼容性与后续边界

1. compare 的输出限制和显式替换是有意收紧；旧脚本如把输出写到当前目录之外，需调整工作目录或输出位置。
2. CLI 现在拒绝曾被忽略的未知参数和重复长选项。使用 `--help` 获取支持列表。
3. 本轮没有改变清单或快照版本，无需为这些改动迁移既有 v2 基线。
4. 本地最终验证环境为 Windows/Node 24；Linux 与 Node 18/22 保留在 CI 配置中，本次没有声称已在远端通过。
5. 没有验证真实 Safari/iPhone，没有把合成性能结果表述为真实大型业务仓库的 SLA。
6. 前端单文件源码仍可在后续按职责拆分；本轮没有为增加文件数量引入打包器，也没有更改报告离线交付方式。

下一步更有价值的是用真实复杂项目持续补充证据密度、链路数量和交互性能样本；本轮已提供可复用的测试和基准入口。
