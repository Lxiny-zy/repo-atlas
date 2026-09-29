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

### 清单提示与批量诊断

仓库已为 VS Code 配置 `atlas.json` / `atlas.next.json` 的字段补全和即时校验，规则来自 [JSON Schema](schemas/atlas.schema.json)。其他位置的清单可添加指向该文件的 `$schema`；相对地址按清单所在目录解析，refresh / accept 移动清单时会自动调整。CLI 不访问这个地址，始终使用随工具分发的本地规则。

```text
node scripts/validate.mjs path/to/atlas.json
node scripts/validate.mjs first/atlas.json second/atlas.json --json
node scripts/validate.mjs path/to/atlas.next.json --review
```

校验一次列出字段类型、拼写、重复 ID、无效引用、缺失或歧义锚点等问题，并用 JSON Pointer 定位字段。`--structure-only` 只检查清单结构与引用；`--review` 将未解析证据降为警告，路径越界仍报错。退出码为 0（本次检查无错误）、1（存在错误）、2（命令用法错误）。未支持的字段会报错，可选字段请省略而非填 `null`；`flags[].value` 允许任意 JSON 值。

构建和增量命令也会先执行共享结构与引用校验。独立校验不生成报告，不递归重建文件索引，也不验证 Git 状态、Mermaid 渲染或审核绑定；校验通过后仍需正式构建与相应验收。完整规则见[清单契约](references/manifest-format.md#编辑器与批量校验)。

### 指定一个功能的闭环

可以把分析范围限定为某个仓库中的单一功能，例如：

```text
请只分析 order-service 中的“订单创建”功能闭环。

入口：POST /orders
追踪：鉴权、参数校验、业务编排、订单写入、库存扣减、消息发布、异步状态更新
必须覆盖：成功、失败、重试、幂等和下游读取
允许纳入：相关公共模块、配置、队列和数据模型
不分析：订单查询、退款和后台报表
输出：模块总览、自然语言流程说明、数据流、发现项和覆盖矩阵
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

新快照采用 v2 格式，保存脱敏后的历史摘录和逐仓库基线。升级时请在完成当前源码复核后重新运行 `snapshot.mjs`；v1 快照无法补回当时的未提交源码，不会自动迁移成可信历史。工作区迁移到其他路径后也需要重新建立基线。

`context` 与 `refresh` 会验证基线、清单语义和当前源码哈希；如果生成 delta 后源码继续变化，请重新生成 delta。历史全文与 Git 提交不一致时，context 保留快照中的旧摘录，并明确说明全文 diff 不可用。`redact` 覆盖整个公开上下文及报告数据；默认上下文预算为 256 KiB，可用 `--max-bytes` 调整，截断和省略数量会写入 `budget`。`--previous-manifest` 优先提供旧摘要，也可用于恢复旧脱敏策略。

模块可选填 `paths: ["src/orders", "src/shared.ts"]`，把分析范围内尚未被引用的文件关联到模块。其他变更进入 `unmappedChanges` 并要求复核；候选刷新会保留尚未关闭的复核标记和队列。候选默认位于输入清单旁，指定其他输出目录时自动调整 `workspace`；所有增量 JSON 输出均防止覆盖输入、通过链接越界，并采用原子写入。

### 记录复核并接受候选

在修改候选结论、核对源码之后生成复核单：

```text
node scripts/review.mjs path/to/atlas.next.json --output .repo-atlas/review.json
```

填写复核单的 `reviewer`、带时区的 `reviewedAt`，并逐项填写 `decision` 和 `note`。只有所有条目明确设为 `approved` 且说明非空时，才能接受；`pending`、`deferred` 或 `needs_changes` 都会阻止接受。不要修改任务描述、指纹或绑定信息。工具会记录全部语义对象、未归属变更及分析边界的确认，不会代替审核人作出决定。

```text
node scripts/accept.mjs path/to/atlas.next.json --review .repo-atlas/review.json
```

接受步骤重新校验基线、候选和源码，执行正式构建，生成 `.repo-atlas/accepted/<version>/`，包含 `atlas.json`、`snapshot.json`、`report.html` 和 `review.json`。该版本目录整体发布，失败时清理暂存内容；不会覆盖原清单、原基线或已有版本。后续使用新版本的清单和 `--from` 指定的新基线继续增量。已审核报告重建时也会检查版本漂移。复核记录是本地声明及版本校验记录，不提供身份认证或数字签名。

缺失或歧义证据需要先修复或移出候选引用，再重新生成复核单；它们不能被批准为正式交付。排查时可先生成显式的复核预览：

```text
node scripts/build.mjs path/to/atlas.next.json --review
```

复核预览显示“仅供复核”及未解析证据原因，不伪造摘录或行号。普通 build 保持严格校验。

### 复杂项目的多链路交付

复杂项目不要把所有用户旅程、事件消费、批处理和补偿逻辑塞进一张总图。`atlas.json` 可以用 `chains` 描述多个业务链路，每条链路按阶段记录证据覆盖度；报告前端把触发、阶段摘要、结果和待确认项展示成自然语言流程卡片，状态图、数据图或失败恢复图按需要补充。报告首页会显示业务链路目录，链路详情会显示阶段进度、触发与结果、关联视图和待确认项。

阶段状态使用 `covered`、`partial`、`unknown` 或 `not_applicable`。已覆盖和部分覆盖阶段必须有源码证据；待确认阶段必须写出下一步核验位置。格式和完整示例见 [references/manifest-format.md](references/manifest-format.md)。

阶段还可以标注 `kind`，推荐使用 `entry`、`authorization`、`validation`、`orchestration`、`read`、`write`、`side_effect`、`publication`、`consume`、`outcome` 和 `recovery`。报告会据此提示链路边界是否完整，并支持按覆盖状态筛选大量链路。

报告总览优先展示项目说明、关系图和关键发现；流程页直接展示当前链路，证据索引直接提供搜索与筛选。阶段可直接打开源码依据，弹窗支持返回上一级并保留阅读位置，摘录显示逐行行号与首行锚点。

链路覆盖度只统计适用阶段，`not_applicable` 单独计数；部分覆盖和待确认阶段不会计入已覆盖数量。覆盖状态与待复核状态分别展示，阶段证据需要复核时也会提示整条链路。

证据索引每页 50 条，链路目录每页 12 条；筛选后回到第一页。搜索缓存标准化文本，并显示匹配总数。增量弹窗列出所有待复核证据及尚未确认归属的文件。

视图、链路详情、阶段和证据都支持复制定位链接；打开链接可恢复对应位置并高亮阶段。定位信息保存在 URL 的 `#` 片段中，分享或移动离线报告时可保留该片段。为证据填写稳定 `source.id` 可避免数组重排导致链接变化。

需要同时保存候选当前快照时：

```text
node scripts/delta.mjs path/to/atlas.json --snapshot-output .repo-atlas/current-snapshot.json
```

### 验证报告

```text
node scripts/verify.mjs path/to/report.html --playwright <installed-playwright/index.mjs>
node scripts/verify.mjs path/to/report.html --playwright <installed-playwright/index.mjs> --browser firefox
node scripts/verify.mjs path/to/report.html --playwright <installed-playwright/index.mjs> --browser webkit
```

验证脚本会检查 Mermaid 渲染、页面错误、缩放拖动、证据弹窗、搜索、索引、导出、全屏和移动端布局。它不会下载浏览器或项目依赖。

运行 `npm test` 验证增量链路、复核流程和文件边界；运行 `npm run benchmark -- --scales 1000,10000` 生成可重复的本地合成规模测试结果。CI 配置覆盖 Windows/Linux、Node 18/22/24，并单独运行固定 Playwright 版本的浏览器回归。

浏览器 CI 现覆盖 Chromium、Firefox 和 WebKit，并包含复核预览及已审核版本。Windows WebKit 在导航前启用离线模拟会内部报错，因此验证器阻断全部 HTTP 请求，加载实际本地文件后再启用离线模拟；结果的 `offlineEmulation` 标明此差异。WebKit 引擎测试不等于真实 Safari 或 iPhone 验收。

### 目录结构

```text
SKILL.md                         Codex 技能指令
agents/openai.yaml               技能在 Codex 中的显示信息
scripts/build.mjs                清单校验与 HTML 生成
scripts/validate.mjs             批量清单与证据诊断
schemas/atlas.schema.json        编辑器提示与共享字段规则
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

### Validate manifests

The repository configures VS Code completion and validation for `atlas.json` and `atlas.next.json` using [the bundled JSON Schema](schemas/atlas.schema.json). External manifests can point `$schema` at that local file. Relative schema links are rebased when refresh or acceptance relocates a manifest; CLI tools never fetch that address.

```text
node scripts/validate.mjs first/atlas.json second/atlas.json --json
```

Diagnostics aggregate field errors, duplicate IDs, broken references, unavailable paths and unresolved evidence, with JSON Pointer locations. `--structure-only` skips filesystem checks; `--review` downgrades unresolved evidence to warnings while retaining path errors. Exit codes are 0 for no errors, 1 for validation errors, and 2 for incorrect usage. Unknown fields are rejected; omit optional fields instead of passing null. `flags[].value` permits any JSON value. Build and incremental commands share the structural preflight. This check does not render Mermaid, rebuild the recursive inventory, inspect Git state, or approve review bindings.

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
Output: module map, readable flow narrative, data flow, findings, and coverage matrix
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

Snapshots now use v2, storing sanitized historical excerpts and per-repository baselines. Recreate a reviewed baseline when upgrading from v1 or relocating a workspace; missing historical working-tree content cannot be reconstructed automatically. Context and refresh reject baseline, semantic manifest, or source drift. Historical diffs require a Git blob matching the snapshot hash and a known redaction policy; otherwise the reason is explicit. Redaction covers the entire public context and report data. Context defaults to a 256 KiB serialized budget (`--max-bytes`), with explicit omission counts.

Optional module `paths` assign scanned files to modules; unowned changes require review through `unmappedChanges`. Refresh preserves pending review flags and queues. Candidates default beside the input manifest and rebase their workspace when relocated. Incremental outputs protect inputs, check link containment, and use atomic writes.

### Record reviews and accept a candidate

Run `node scripts/review.mjs path/to/atlas.next.json` after editing and checking the candidate. Fill in `reviewer`, an ISO `reviewedAt` with timezone, and an explicit `approved` decision plus a nonempty note for every task. Pending or deferred tasks block acceptance; do not edit task definitions, fingerprints, or bindings.

Run `node scripts/accept.mjs path/to/atlas.next.json --review .repo-atlas/review.json`. It validates the candidate, source and baseline versions, performs a strict build, and publishes a new `.repo-atlas/accepted/<version>/` directory containing the manifest, report, snapshot, and review receipt. Existing inputs and release directories remain protected. Use the accepted manifest and its snapshot as the next baseline. Review records document local decisions and version checks; they are not identity authentication or digital signatures.

Unresolved evidence blocks acceptance. `build.mjs --review` produces an explicitly labeled review preview with unresolved placeholders, while ordinary builds remain strict. Fix or remove the unresolved references and generate a fresh review before acceptance.

### Multi-chain delivery for complex repositories

Do not compress user journeys, event consumers, batch jobs, and compensation flows into one diagram. Use `chains` in `atlas.json` to register each important flow and record evidence coverage for each stage. The report renders the trigger, stage summaries, outcome, and unresolved checks as readable prose cards; add state, data, consistency, recovery, or deployment views only when they answer a concrete reader question. The report homepage shows a chain directory; opening a chain shows its stage progress, trigger and outcome, related views, and unresolved checks.

Stage status is one of `covered`, `partial`, `unknown`, or `not_applicable`. Covered and partial stages require source evidence; unknown stages require a concrete `nextCheck`. See [references/manifest-format.md](references/manifest-format.md) for the schema and full example.

Stage `kind` should use a stable semantic vocabulary such as `entry`, `authorization`, `validation`, `orchestration`, `read`, `write`, `side_effect`, `publication`, `consume`, `outcome`, or `recovery`. The report uses these labels to surface inconsistent chain boundaries and to make large chain directories easier to filter.

The overview prioritizes the project description, relationship map, and key findings. Flow pages start with the current chain, while the evidence index starts with search and filters. Stage evidence opens directly; dialogs support returning to the previous level with the reading position preserved. Excerpts include line numbers and highlight the first-line anchor.

Chain coverage counts applicable stages only, listing `not_applicable` separately. Partial and unknown stages do not count as covered. Coverage and review status are displayed independently, and a stage requiring review also marks its parent chain for review.

The catalog shows 50 entries per page and the chain directory 12. Search text is cached and results show the total match count. The update dialog includes the full stale-evidence list and unowned changes.

Copy links to views, chains, stages and evidence. URL fragments restore the destination and highlight stages. Preserve the fragment when moving a standalone report; stable source IDs preserve evidence links across source-array reordering.

To persist a candidate current snapshot as well:

```text
node scripts/delta.mjs path/to/atlas.json --snapshot-output .repo-atlas/current-snapshot.json
```

### Verify a report

```text
node scripts/verify.mjs path/to/report.html --playwright <installed-playwright/index.mjs>
```

The verifier checks Mermaid rendering, page errors, pan/zoom, evidence dialogs, search, indexes, exports, fullscreen, and mobile layout. It does not download browsers or project dependencies.

`npm test` covers incremental, review, and filesystem regressions. `npm run benchmark -- --scales 1000,10000` runs local synthetic scale checks. CI is configured for Windows/Linux and Node 18/22/24, plus pinned Playwright browser checks.

Pass `--browser chromium|firefox|webkit` to the verifier. Browser CI also checks review previews and accepted reports. On Windows, WebKit loads the actual local file with all HTTP requests blocked, then enables offline emulation to avoid a pre-navigation emulation failure. Results identify this timing difference. Engine checks do not validate real Safari or iPhone devices.

### Repository layout

```text
SKILL.md                         Codex skill instructions
agents/openai.yaml               Codex UI metadata
scripts/build.mjs                Manifest validation and HTML generation
scripts/validate.mjs             Batch manifest and evidence diagnostics
schemas/atlas.schema.json        Editor assistance and shared field rules
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
