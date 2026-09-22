# repo-atlas

Evidence-backed project and feature maps that remain useful after the code changes.

基于真实源码生成可追溯的项目与功能图谱，并通过本地快照和增量差异保持分析结果可维护。

## 中文

### 项目简介

`repo-atlas` 将人工维护的 `atlas.json` 清单转换为一个可离线打开的单文件 HTML 报告。报告中的模块关系、业务链路、数据对象、发现项和覆盖矩阵都绑定到真实源码摘录，而不是只根据目录名或类名猜测架构。

它适合：

- 接手复杂项目时梳理模块边界和关键业务链路；
- 针对某个仓库中的某个功能，追踪入口到结果的链路闭环；
- 生成可搜索、可缩放、可导出的离线 Mermaid 架构图谱；
- 在首次分析后，用本地哈希、Git 状态和证据反向索引做低成本增量复核。

它不替代专项代码审计、缺陷修复、生产验证或新系统设计。

### 主要能力

- **证据优先**：源码路径、稳定文本锚点和摘录行号随报告保存。
- **范围可控**：可以限定整个仓库、模块、业务功能或必要的上下游支撑范围。
- **多链路交付**：复杂项目用 `chains` 登记每条核心业务链，并把入口、校验、编排、读写、副作用、结果和失败恢复拆成阶段。
- **离线交付**：Mermaid、Lucide、样式和交互逻辑内嵌到一个 HTML 文件，无 CDN 依赖。
- **可信度标注**：区分 `confirmed`、`inferred`、`unverified`，并用覆盖矩阵暴露缺口。
- **增量更新**：区分新增、修改、删除、重命名、失效证据和建议全量复核的原因。
- **隐私边界**：默认只提取清单中指定的证据，不把凭据、环境文件或整个源码打包进报告。

### 环境要求

- Node.js 18 或更高版本；
- 生成报告不需要安装 npm 依赖；
- 浏览器回归验证可选，需要一个已安装的 Playwright 模块和本机浏览器。

### 快速开始

1. 在项目文档目录创建 UTF-8 编码的 `atlas.json`，格式见 [references/manifest-format.md](references/manifest-format.md)。
2. 生成离线报告：

   ```text
   node scripts/build.mjs path/to/atlas.json
   ```

3. 生成后直接双击 `output` 指定的 HTML 文件即可打开。

如果要更新已有报告，必须显式使用 `--replace`：

```text
node scripts/build.mjs path/to/atlas.json --replace
```

### 指定一个功能的闭环

可以把分析范围限定为某个仓库中的单一功能，例如：

```text
请只分析 order-service 中的“订单创建”功能闭环。

入口：POST /orders
追踪：鉴权、参数校验、业务编排、订单写入、库存扣减、消息发布、异步状态更新
必须覆盖：成功、失败、重试、幂等和下游读取
允许纳入：相关公共模块、配置、队列和数据模型
不分析：订单查询、退款和后台报表
输出：模块图、时序图、数据流、发现项和覆盖矩阵
```

在 `atlas.json` 中，`project.scope` 和 `project.boundary` 描述语义边界，`fileGroups.paths` 与 `exclude` 约束文件范围。必要的鉴权、队列、配置或数据模型可以作为支撑范围纳入，但不会自动扩展成全仓库分析。

### 首次快照与增量更新

首次报告完成后保存本地快照：

```text
node scripts/snapshot.mjs path/to/atlas.json
```

后续再次调用技能或手动执行以下命令：

```text
node scripts/delta.mjs path/to/atlas.json
node scripts/refresh.mjs path/to/atlas.json --delta .repo-atlas/delta.json
node scripts/build.mjs path/to/atlas.next.json
```

增量流程只在本地计算文件元数据、SHA-256、Git 状态和证据反向索引，不会把未变化源码重新放入模型上下文。刷新器输出 `atlas.next.json`，不会静默覆盖基线清单；复核受影响证据后再接受候选结果。

`delta.json` 会报告：

- 新增、修改、删除和可确认的重命名；
- 受影响的模块、视图、发现项和覆盖项；
- 可复用、需重算和已经失效的证据数量；
- 清单或公共基础设施变化；
- 是否建议全量重分析以及具体原因。

如果只需要把本次变更交给模型复核，不要重新加载整个仓库，可以生成增量上下文包：

```text
node scripts/context.mjs path/to/atlas.json --changed-only
```

`.repo-atlas/context.json` 只包含变更文件的 diff、受影响的链路与阶段、变更前后证据摘录和一跳上下游关系。快照中的轻量摘要索引提供变更前摘要，证据摘录继续遵守 `redact` 脱敏规则；使用 `--stale-only` 可以只处理失效证据。

### 复杂项目的多链路交付

复杂项目不要把所有用户旅程、事件消费、批处理和补偿逻辑塞进一张总图。`atlas.json` 可以用 `chains` 描述多个业务链路，每条链路绑定自己的时序图、状态图、数据图或失败恢复图，并按阶段记录证据覆盖度。报告首页会显示业务链路目录，链路详情会显示阶段进度、触发与结果、关联视图和待确认项。

阶段状态使用 `covered`、`partial`、`unknown` 或 `not_applicable`。已覆盖和部分覆盖阶段必须有源码证据；待确认阶段必须写出下一步核验位置。格式和完整示例见 [references/manifest-format.md](references/manifest-format.md)。

阶段还可以标注 `kind`，推荐使用 `entry`、`authorization`、`validation`、`orchestration`、`read`、`write`、`side_effect`、`publication`、`consume`、`outcome` 和 `recovery`。报告会据此提示链路边界是否完整，并支持按覆盖状态筛选大量链路。

需要同时保存候选当前快照时：

```text
node scripts/delta.mjs path/to/atlas.json --snapshot-output .repo-atlas/current-snapshot.json
```

### 验证报告

```text
node scripts/verify.mjs path/to/report.html --playwright <installed-playwright/index.mjs>
```

验证脚本会检查 Mermaid 渲染、页面错误、缩放拖动、证据弹窗、搜索、索引、导出、全屏和移动端布局。它不会下载浏览器或项目依赖。

### 目录结构

```text
SKILL.md                         Codex 技能指令
agents/openai.yaml               技能在 Codex 中的显示信息
scripts/build.mjs                清单校验与 HTML 生成
scripts/snapshot.mjs             首次快照
scripts/delta.mjs                增量差异
scripts/refresh.mjs              候选清单刷新
scripts/context.mjs              增量模型上下文打包
scripts/verify.mjs               浏览器交互验证
scripts/test.mjs                 本地回归夹具
scripts/snapshot-lib.mjs         快照与证据索引实现
references/                      清单契约、分析指南和提示词
assets/report/                   离线报告模板、样式、脚本和固定版本资源
```

### 证据与安全边界

- 证据锚点缺失或变得有歧义时标记为失效，不沿用旧摘录冒充当前事实。
- 动态分派、反射、生成代码、运行时配置和线上状态不能仅凭静态清单确认。
- 配置只展示明确选择且可公开的值；发布前仍应人工检查 `atlas.json` 和 HTML。
- `.repo-atlas/`、浏览器验证产物和临时文件默认不应提交到项目仓库。

### 许可证

本项目使用 [MIT License](LICENSE)。报告模板中随附的 Mermaid 和 Lucide 浏览器包保留各自的上游许可证，详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

---

## English

### What it is

`repo-atlas` turns a human-maintained `atlas.json` manifest into a self-contained, offline HTML report. Modules, business flows, data objects, findings, and coverage entries point to real source excerpts instead of inferring architecture from folder or class names alone.

It is useful for:

- understanding module boundaries and critical flows in an unfamiliar repository;
- tracing one feature from its entry point through validation, orchestration, persistence, side effects, and downstream reads;
- delivering searchable, zoomable Mermaid diagrams that work offline;
- refreshing a reviewed baseline incrementally with local hashes, Git state, and a reverse evidence index.

It is not a replacement for a security audit, bug fix, production verification, or system design.

### Highlights

- **Evidence first**: source paths, stable text anchors, and excerpt line numbers are retained.
- **Explicit scope**: analyze a repository, module, feature, or the supporting upstream/downstream code needed to close the loop.
- **Multi-chain delivery**: register each critical business chain in `chains`, then split entry, validation, orchestration, reads/writes, side effects, outcomes, and recovery into evidence-backed stages.
- **Offline output**: Mermaid, Lucide, styles, and interaction logic are embedded in one HTML file.
- **Confidence labels**: distinguish `confirmed`, `inferred`, and `unverified`, with a coverage matrix for gaps.
- **Incremental refresh**: report additions, modifications, deletions, renames, stale evidence, and full-review triggers.
- **Privacy boundaries**: only selected evidence is extracted; credentials, environment files, and unrelated source are not bundled by default.

### Requirements

- Node.js 18 or newer;
- no npm dependencies are required to build a report;
- optional browser regression checks require an installed Playwright module and a local browser.

### Quick start

1. Create a UTF-8 `atlas.json` in your documentation directory. See the [manifest contract](references/manifest-format.md).
2. Build the report:

   ```text
   node scripts/build.mjs path/to/atlas.json
   ```

3. Open the HTML path declared by `output` directly from disk.

To intentionally update an existing report, pass `--replace`:

```text
node scripts/build.mjs path/to/atlas.json --replace
```

### Scope one feature end to end

The skill can focus on a single feature inside a repository, for example:

```text
Analyze only the “create order” flow in order-service.

Entry: POST /orders
Trace: authorization, validation, orchestration, order write, inventory reservation,
       message publication, asynchronous status update
Cover: success, failure, retries, idempotency, and downstream reads
Include: supporting shared modules, configuration, queues, and data models as needed
Exclude: order queries, refunds, and back-office reports
Output: module map, sequence diagram, data flow, findings, and coverage matrix
```

Use `project.scope` and `project.boundary` for the semantic boundary, and `fileGroups.paths` / `exclude` for file-level limits. Supporting auth, queue, configuration, or data-model code may be included when it is required for a truthful closed loop; the scope does not silently become the whole repository.

### Snapshots and incremental refresh

After the first report, create a local baseline:

```text
node scripts/snapshot.mjs path/to/atlas.json
```

On a later skill invocation or manually:

```text
node scripts/delta.mjs path/to/atlas.json
node scripts/refresh.mjs path/to/atlas.json --delta .repo-atlas/delta.json
node scripts/build.mjs path/to/atlas.next.json
```

The incremental path computes file metadata, SHA-256 hashes, Git state, and the reverse evidence index locally. Unchanged source is not sent back into the model context. `refresh.mjs` writes `atlas.next.json` and never silently replaces the reviewed baseline; accept it only after checking affected evidence.

`delta.json` includes added, modified, deleted, and confidently detected renamed files; impacted entities; reusable, recomputed, and stale evidence counts; manifest or infrastructure changes; and full-reanalysis reasons.

To prepare a small model-ready handoff instead of reloading the repository, generate an incremental context bundle:

```text
node scripts/context.mjs path/to/atlas.json --changed-only
```

The resulting `.repo-atlas/context.json` contains only changed-file hunks, affected entities and chain stages, previous/current evidence excerpts, and one-hop module relationships. Snapshot files retain a compact summary index, so prior summaries are available without storing a second full manifest. Evidence excerpts honor each source's `redact` list. Use `--stale-only` to focus on invalid evidence, or `--previous-manifest atlas.previous.json` to override the stored summaries explicitly.

### Multi-chain delivery for complex repositories

Do not compress user journeys, event consumers, batch jobs, and compensation flows into one diagram. Use `chains` in `atlas.json` to register each important flow, connect it to its own sequence, state, data, consistency, recovery, or deployment views, and record evidence coverage for each stage. The report homepage shows a chain directory; opening a chain shows its stage progress, trigger and outcome, related views, and unresolved checks.

Stage status is one of `covered`, `partial`, `unknown`, or `not_applicable`. Covered and partial stages require source evidence; unknown stages require a concrete `nextCheck`. See [references/manifest-format.md](references/manifest-format.md) for the schema and full example.

Stage `kind` should use a stable semantic vocabulary such as `entry`, `authorization`, `validation`, `orchestration`, `read`, `write`, `side_effect`, `publication`, `consume`, `outcome`, or `recovery`. The report uses these labels to surface inconsistent chain boundaries and to make large chain directories easier to filter.

To persist a candidate current snapshot as well:

```text
node scripts/delta.mjs path/to/atlas.json --snapshot-output .repo-atlas/current-snapshot.json
```

### Verify a report

```text
node scripts/verify.mjs path/to/report.html --playwright <installed-playwright/index.mjs>
```

The verifier checks Mermaid rendering, page errors, pan/zoom, evidence dialogs, search, indexes, exports, fullscreen, and mobile layout. It does not download browsers or project dependencies.

### Repository layout

```text
SKILL.md                         Codex skill instructions
agents/openai.yaml               Codex UI metadata
scripts/build.mjs                Manifest validation and HTML generation
scripts/snapshot.mjs             Initial snapshot
scripts/delta.mjs                Incremental diff
scripts/refresh.mjs              Candidate manifest refresh
scripts/context.mjs              Model-ready incremental context bundle
scripts/verify.mjs               Browser interaction checks
scripts/test.mjs                 Local regression fixture
scripts/snapshot-lib.mjs         Snapshot and evidence index implementation
references/                      Manifest contract, analysis guide, and prompts
assets/report/                   Offline template, styles, scripts, and pinned assets
```

### Evidence and safety boundaries

- Missing or ambiguous anchors become stale; old excerpts are never presented as current facts.
- Dynamic dispatch, reflection, generated code, runtime configuration, and live state require direct verification.
- Only explicitly selected, shareable configuration values belong in a report; review `atlas.json` and the HTML before publishing.
- `.repo-atlas/`, browser verification artifacts, and temporary files should normally stay out of version control.

### License

This project is released under the [MIT License](LICENSE). The bundled Mermaid and Lucide browser assets retain their upstream licenses; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
