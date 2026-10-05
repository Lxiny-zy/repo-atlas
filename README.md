# repo-atlas

**源码有据、变更可复核的离线架构图谱。**

[![CI](https://github.com/Lxiny-zy/repo-atlas/actions/workflows/ci.yml/badge.svg)](https://github.com/Lxiny-zy/repo-atlas/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.en.md) · [文档导航](docs/README.md) · [命令参考](docs/cli.md) · [清单格式](references/manifest-format.md) · [参与贡献](CONTRIBUTING.md)

![订单业务报告预览：先解释全貌，再按场景阅读](examples/order-journey/desktop.png)

repo-atlas 把人工或 AI 辅助编写的 `atlas.json` 转换成可离线打开的单文件 HTML。模块关系、业务链路、数据对象和发现项可以直接回到源码摘录；代码变化后，通过快照、增量差异和显式复核维护结论。

适合接手陌生代码库、追踪一个功能的完整链路、交付可持续更新的架构说明。**它不会自动理解业务，也不把静态关系当成运行时调用证明。**

## 五分钟体验

需要 Node.js 18+；建议使用仍受官方维护的 Node.js LTS。构建没有 npm 运行时依赖，无需先执行 `npm install`。

```sh
git clone https://github.com/Lxiny-zy/repo-atlas.git
cd repo-atlas
node scripts/validate.mjs examples/order-journey/atlas.json
node scripts/build.mjs examples/order-journey/atlas.json
```

直接打开 `examples/order-journey/report.html`，体验“提交购买”和“取消订单”两个中文场景。先读业务过程和结论，需要核对实现时再展开源码。示例使用仓库内的合成源码，明确保留支付、物流和长期存储尚未覆盖的边界。再次构建同一输出需追加 `--replace`。

编写自己的报告前，可参考[读者体验与表达约束](references/reader-experience.md)：用业务名称组织标题与阶段，函数、路径和字段保留在定位细节中。

想体验完整的多链路报告：

```sh
node scripts/build.mjs tests/fixtures/multi-chain/atlas.json
```

打开 `tests/fixtures/multi-chain/report.html`。报告内嵌 Mermaid、图标、样式和交互脚本，不依赖 CDN 或本地服务器。

## 能做什么

| 需求 | 实现 |
|---|---|
| 解释模块关系 | 总览、模块详情、已编写的上下游关系与可定位链接 |
| 讲清业务链路 | 触发、分阶段处理、证据、结果、失败恢复与待确认项 |
| 查验依据 | 源码锚点、行号摘录、证据搜索、歧义与失效提示 |
| 暴露知识缺口 | confirmed / inferred / unverified，以及独立的覆盖和复核状态 |
| 维护旧报告 | 文件哈希、Git 基线、受影响实体、未归属变化和增量上下文 |
| 交付审核版本 | 显式复核单、新版本目录、报告完整性回执与语义版本比较 |

链路覆盖率只计算适用阶段，不把未确认阶段当成已覆盖。关系导航反映清单中的知识，不据此判断变更影响半径或合并安全性。

## 用于自己的项目

1. 阅读[清单格式](references/manifest-format.md)，参考 [atlas.example.json](schemas/atlas.example.json) 创建项目文档目录下的 `atlas.json`。
2. 设置 `workspace`，它**相对清单所在目录**解析；证据路径、文件分组和 `output` 均相对 workspace。
3. 为模块、链路与结论选择少量真实源码证据，写明分析边界和未确认项。
4. 先校验，再构建。

```sh
node /path/to/repo-atlas/scripts/validate.mjs docs/architecture/atlas.json
node /path/to/repo-atlas/scripts/build.mjs docs/architecture/atlas.json
```

例如清单位于 `your-project/docs/architecture/atlas.json`，可以设置 `workspace: "../.."`、`output: "docs/architecture/report.html"`。在 Windows 上将命令中的工具路径替换成实际路径，含空格时加引号。

仓库为 VS Code 提供 JSON Schema 关联；外部清单可以通过 `$schema` 指向本地 [atlas.schema.json](schemas/atlas.schema.json)。CLI 始终使用随工具分发的规则，不访问该地址。

### 作为 Agent 技能

本仓库包含 [SKILL.md](SKILL.md)、显示元数据和配套脚本。将整个仓库放在宿主支持的技能目录中，保留目录结构；宿主安装方式以其自身文档为准。也可以不安装技能，直接使用 Node CLI。

一个明确范围的请求示例：

> 分析订单创建功能，从 POST /orders 追踪鉴权、校验、订单写入、库存扣减和事件消费。覆盖成功、失败、重试、幂等和补偿；只纳入必要的公共模块、配置与数据模型。交付业务链路、源码依据和待确认项。

## 代码变化后如何维护

首次完成源码复核后创建基线：

```sh
node scripts/snapshot.mjs path/to/atlas.json
```

后续代码变化时：

```sh
node scripts/delta.mjs path/to/atlas.json
node scripts/context.mjs path/to/atlas.json --changed-only
node scripts/refresh.mjs path/to/atlas.json
```

这些命令默认把状态保存到 **workspace 下**的 `.repo-atlas/`，并在原清单旁生成 `atlas.next.json`。上下文包默认上限为 256 KiB，记录截断和省略情况。证据文件每次重新核对哈希；非证据文件可以复用未变化的元数据缓存。

检查受影响源码、修改候选清单并补齐证据后：

```sh
node scripts/review.mjs path/to/atlas.next.json
```

实际复核后填写 `.repo-atlas/review.json` 的 `reviewer`、带时区的 `reviewedAt`，以及每项 `decision` 和 `note`。全部明确批准后才能接受：

```sh
node scripts/accept.mjs path/to/atlas.next.json --review .repo-atlas/review.json
```

生成的新版本目录包含 `atlas.json`、`snapshot.json`、`report.html`、`review.json` 和 `delivery.json`。原清单、基线和已有版本保留。下一轮使用接受后的清单，并通过 `--from` 指向该版本快照，详见[命令参考](docs/cli.md)。

证据缺失或歧义会阻止正式接受；临时排查可使用 `build.mjs --review` 生成标有“仅供复核”的报告。候选、源码或基线改变后，旧复核记录不能继续用于接受。

### 检查交付与比较版本

```sh
node scripts/check-delivery.mjs .repo-atlas/accepted/VERSION
node scripts/compare.mjs old/atlas.json new/atlas.json --json
node scripts/compare.mjs old/atlas.json new/atlas.json --output changes.json
```

compare 不要求源仓库在线，比较清单中的语义实体。输出必须位于当前工作目录内；已有结果需显式 `--replace`，两个输入始终禁止覆盖。交付回执检测绑定文件的完整性，不提供审核人身份认证或数字签名。

## 验证与质量

```sh
npm run check
npm test
node scripts/benchmark.mjs --scales 1000,10000
```

`check` 校验一方 JavaScript 语法和受维护文档的本地文件链接；`test` 自动发现回归测试并执行端到端夹具。CI 配置 Windows/Linux × Node 18/22/24，以及 Chromium、Firefox、WebKit 的普通、复核预览和已接受报告回归。

可选浏览器验证需要另外提供 Playwright 和匹配的浏览器：

```sh
node scripts/verify.mjs tests/fixtures/multi-chain/report.html --playwright /path/to/playwright/index.mjs --browser chromium
```

验证器不安装依赖或下载浏览器。WebKit 的离线模拟时序差异会写入验证结果；引擎验证不等于真实 Safari/iPhone 验收。复现开发环境及扩展基准场景见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 边界与兼容性

- 清单校验通过不等于业务分析完整。反射、动态分派、生成代码和线上配置需要额外证据。
- `redact` 是字面脱敏机制，不是自动秘密检测；分享报告前检查清单与摘录。
- 快照 v2 保存脱敏历史摘录及逐仓库基线；从 v1 升级或迁移 workspace 后，需要复核源码并重建基线。
- 生成器、报告和增量工具均在本地工作。报告包含选定的源码片段，应按源码本身的访问范围分发。
- 当前发布版本见 [package.json](package.json)，尚未发布的变化见 [CHANGELOG.md](CHANGELOG.md)。

## 项目导航

- [架构与扩展边界](docs/architecture.md)
- [仓库维护流程](docs/maintaining.md) / [行为准则](CODE_OF_CONDUCT.md)
- [分析指南](references/analysis-guide.md) / [可复制提示词](references/可复制提示词.md)
- [贡献流程](CONTRIBUTING.md) / [安全报告](SECURITY.md)
- [MIT 许可证](LICENSE) / [第三方声明](THIRD-PARTY-NOTICES.md)

问题与建议请使用 [GitHub Issues](https://github.com/Lxiny-zy/repo-atlas/issues)，附最小合成示例、实际结果和运行环境；避免上传业务源码或生成报告中的敏感摘录。
