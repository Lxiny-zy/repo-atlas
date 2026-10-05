# atlas.json 输入契约

生成器执行指定证据的提取与索引统计，不从目录自动推断业务架构。输入使用 UTF-8 JSON，不使用可执行 JavaScript 配置。

`name`、`title`、`label`、`summary`、`trigger`、`outcome` 是直接给读者看的内容，应使用业务语言；稳定 `id`、证据路径和函数锚点承担技术定位。具体写法见 [读者体验与表达约束](reader-experience.md)，完整中文示例见 [订单业务清单](../examples/order-journey/atlas.json)。

## 编辑器与批量校验

[schemas/atlas.schema.json](../schemas/atlas.schema.json) 使用 JSON Schema draft 2020-12，覆盖项目、模块、视图、链路/阶段、证据、发现项、覆盖项及各类索引。仓库的 `.vscode/settings.json` 已关联 `atlas.json` 和 `atlas.next.json`。也可在清单顶层添加 `$schema`，值为相对清单的 Schema 文件路径，或编辑器可读取的绝对文件地址；CLI 始终使用随工具提供的 Schema，不下载或执行用户指定的地址。

```text
node scripts/validate.mjs first/atlas.json second/atlas.json --json
node scripts/validate.mjs atlas.json --structure-only
node scripts/validate.mjs atlas.next.json --review
```

- 默认检查字段类型与格式、条件必填项、重复身份、模块/视图引用、每处证据锚点、扫描/仓库根路径，以及输出与显式输入的冲突。一个清单报错后继续检查后面的清单；结构错误不遮挡其他有效证据定义的检查。
- `--structure-only` 检查结构与引用，不读取 workspace 或源码。`--review` 仅将缺失、歧义等未解析证据降为警告，不能放过字段错误、路径越界或输入/输出冲突。
- JSON 结果包含 `schemaVersion: 1`、`mode`、`valid`、`summary` 和逐文件 `results`。每条诊断有 `severity`、稳定分类 `code`、JSON Pointer `path` 和 `message`；重复身份另外提供 `relatedPath`。根路径表示为 `""`，`~`、`/` 按 JSON Pointer 转义。
- `checks` 标记哪些检查阶段已执行，不代表各阶段通过；是否有错误由 `valid` 与诊断判断。`--review` 下 `valid: true` 可同时存在警告，不表示能够接受或发布。
- 命令只读，结果写入标准输出；退出码 0 表示本次检查无错误，1 表示存在校验错误，2 表示命令参数错误。诊断不回显源码或无效 JSON 原文，已解析清单的诊断遵循有效 `redact` 字面值的并集。
- 不递归扫描整个索引，不检查 Git 仓库状态、Mermaid 渲染、审核绑定或业务结论。正式 build、增量漂移校验和 accept 仍分别执行这些流程需要的检查。

核心对象拒绝未知字段和显式 `null`，以发现拼写错误；可选字段请省略。`flags[].value` 允许任意 JSON 值（包括 `null`）；工具生成的 `update` / `review` 内部字段由对应工作流核验，Schema 不代表审核授权。无 `$schema` 的旧清单继续可用；`$schema` 不参与语义清单哈希，refresh / accept 会保留相对链接的实际目标。

运行时校验器只实现随附 Schema 使用的关键字，不是通用 JSON Schema 引擎；新增未知关键字会在启动时报错。开发时可安装临时 Ajv 并独立对照验证，运行和构建无 npm 依赖：

```text
npm install --prefix tmp-schema-validation --no-save --package-lock=false ajv@8.20.0
node scripts/verify-schema.mjs --ajv tmp-schema-validation/node_modules/ajv/dist/2020.js
```

## 最小示例

下列是 Python 导入工具的示意，文件、锚点、职责和图在使用前必须替换为实际读取结果。复杂项目增加视图和模块即可，不需要改生成器。

```json
{
  "workspace": "..",
  "output": "docs/项目模块关系图.html",
  "project": {
    "title": "资料导入工具 · 项目图谱",
    "subtitle": "IMPORT WORKSPACE",
    "scope": "CLI 入口与文件导入链路。",
    "boundary": "仅核对当前源码与配置；未运行外部存储服务。"
  },
  "repositories": [{ "name": "import-tool", "path": "." }],
  "fileGroups": [
    { "name": "命令行与处理器", "paths": ["src"], "extensions": [".py"], "exclude": ["tests"] }
  ],
  "modules": [
    {
      "id": "cli",
      "name": "导入入口",
      "category": "入口",
      "icon": "terminal",
      "summary": "解析命令参数后调用资料解析器。",
      "facts": ["输入路径由命令行参数传入。"],
      "links": ["parser"],
      "sources": [{ "path": "src/main.py", "match": "def main(", "length": 12 }]
    },
    {
      "id": "parser",
      "name": "资料解析",
      "category": "核心处理",
      "summary": "读取输入文件并形成规范化记录。",
      "facts": ["解析失败由调用方处理异常。"],
      "links": [],
      "sources": [{ "path": "src/parser.py", "match": "def parse(", "length": 10 }]
    }
  ],
  "views": [
    {
      "id": "overview",
      "title": "模块关系总览",
      "subtitle": "从命令行入口到规范化记录。",
      "group": "全局",
      "tags": ["当前源码"],
      "diagram": "flowchart LR\ncli[命令入口]:::entry -->|输入文件| parser[资料解析]:::core",
      "mobileDiagram": "flowchart TB\ncli[命令入口]:::entry -->|输入文件| parser[资料解析]:::core",
      "modules": ["cli", "parser"],
      "notes": [["读图说明", "箭头表示调用方向。"]]
    }
  ]
}
```

## 路径与更新

- `workspace`：相对清单所在目录，允许绝对路径指向本次项目工作区。
- `output`：工作区内 HTML 路径。默认拒绝覆盖现有文件，授权更新同一报告后加 `--replace`。
- 所有 source、repository、fileGroup 路径相对 workspace，统一使用 `/`。源码不得通过 `../` 或符号链接逃出工作区。多仓项目以共同上级目录为 workspace。
- 增量更新使用技能目录下的本地快照工具：`node scripts/snapshot.mjs atlas.json` 生成 `.repo-atlas/snapshot.json`，`node scripts/delta.mjs atlas.json` 生成 `.repo-atlas/delta.json`，`node scripts/refresh.mjs atlas.json --delta .repo-atlas/delta.json` 生成待审核的 `atlas.next.json`。这些步骤只读取本地文件和 Git 元数据，不把未变化源码重新送入模型。
- `delta.json` 不嵌入完整当前快照；如需在同一轮保存新快照，显式传 `--snapshot-output`。`summary.reusedEvidence` 只统计文件哈希、摘录哈希和证据定义均未变的条目，`recomputedEvidence` 统计仍可解析但需要重新核对的条目，`staleEvidence` 统计已失效或缺失的条目。
- 快照同时保存原始 `manifestSha256` 与排除候选 `update`、各实体和阶段的运行期字段、输出位置及相对工作区表示后的 `analysisManifestSha256`；工作区身份单独校验。快照还保留经过脱敏的 `summaryIndex` 和历史证据摘录。
- 重命名只在删除与新增文件的 SHA-256 相同且一一配对时报告为 `renamed`；重命名同时修改内容时保留为 `deleted` + `added`，不猜测关系。`--snapshot-output` 不能覆盖 `--from` 指定的基线。
- 删除源文件不会让增量计算中断：对应证据会保留路径、`resolved: false`、空哈希和 `staleReason`。首次正式报告生成仍由 `build.mjs` 严格拒绝缺失或歧义锚点。
- `manifestChanged` 表示分析清单本身发生变化（候选 `update` 字段和运行期 freshness 标记会被排除在比较之外）；它会触发全量复核建议，避免只改结论或证据定义时静默沿用旧判断。
- `summary.changedFileRatio` 是相对基线文件数的本地变更比例；基线至少 10 个文件且比例超过 20%，或一次变更达到 20 个文件时，默认建议全量重分析。
- `summary.fullReanalysisReasons` 记录触发全量建议的具体原因，交给模型或人工复核时优先处理这些原因，而不是盲目重读整个仓库。
- 证据所引用的文件每次增量都会重新计算 SHA-256；未被证据引用的文件在大小、修改时间和变更时间均未变化时可复用本地哈希缓存。这些优化只影响本地 I/O，不改变模型复核范围。
- `refresh.mjs` 生成的 `update` 字段是候选状态；只有重新检查受影响证据并确认后，才应把 `atlas.next.json` 替换为新的分析清单和快照。
- 所有源码链接按输出目录自动生成相对路径；把 HTML 单独发出后内嵌摘录仍可读，链接需要原始仓库结构。
- 项目无 Git 时省略 repositories，不虚构分支。正式 build 读取声明的 Git 仓库失败会报错；快照保留 `available: false`、`dirty: null` 和失败原因，不把读取失败当成干净工作区。
- 文件索引只扫描显式指定的后缀和路径；按真实路径去重，不扫描符号链接目录，默认排除 `.git`、`.repo-atlas`、`node_modules`、`.venv`、`__pycache__`。不将快照产物或整个环境文件加入文件索引或证据。

## 证据字段

```json
{ "path": "src/store.ts", "match": "export async function saveOrder(", "length": 14, "occurrence": 1, "redact": ["需要遮盖的字面值"] }
```

`match` 是字面文本，必须实际出现；重复出现时必须提供从 1 起算的 occurrence，优先选择唯一锚点。`length` 默认 8，范围为 1–60 行。生成器写出真实行号，不接受手填摘录冒充源码。可选 `id` 遵循模块 id 格式，在同一实体内唯一；提供后用它替代 sources 数组下标作为稳定证据身份。

`redact` 是非空字面值数组。构建和上下文使用当前清单全部脱敏值的并集，覆盖公开数据、摘要、匹配文本和 diff；快照保存全局脱敏后的摘录、原始摘录哈希、已存摘录哈希和策略哈希，不保存脱敏字面值列表。源文件保持原样；含遮盖值的原始清单需要妥善保存。

## 增量产物 v2

- 新快照、delta、context 使用 `schemaVersion: 2`。v1 快照不具备可信的历史摘录和工作区身份，升级时需先复核当前状态，再运行 `snapshot.mjs` 创建新基线；不会把当前内容冒充旧历史。迁移到其他工作区路径也需重新创建快照。
- 快照 `repositories` 按仓库路径保存 commit、Git prefix 和工作区状态，文件记录所属 repository。context 按所属仓库批量读取历史 blob，只有 SHA-256 等于快照文件哈希才可生成全文差异；脏工作区、未跟踪文件和不可用历史都有明确原因。旧摘录优先使用快照保存的脱敏值。
- delta 记录工作区身份、完整基线快照哈希、当前语义清单哈希和文件集合哈希。context 和 refresh 重新计算当前集合，发现基线/源码/清单漂移时拒绝输出，须重新运行 delta。
- 阶段实体为 `chain-stage:<chain-id>/<stage-id>`，其证据 key 保留 `chain:<chain-id>/<stage-id>:<source-id-or-index>`；阶段影响同时传递给父链路。
- 模块可选 `paths`，支持工作区相对文件或目录路径，使用 `/`，不支持 glob。只映射 `fileGroups` 或 evidence 已纳入分析的文件，不自行扩大扫描范围。没有证据或模块归属的变更写入 `unmappedChanges`，并设置 `reviewRequired`。
- refresh 默认把候选写在输入清单旁。显式 `--output` 相对 workspace，必要时重写候选中的相对 workspace。所有输出必须是工作区内 JSON，禁止覆盖清单、基线、delta、源码或同次另一个输出；检查符号链接、目录链接和硬链接，使用临时文件和原子替换。两个输出分别原子写入，不提供跨文件事务。
- 候选保留未关闭的复核标记及队列。`review.mjs` 生成复核单，`accept.mjs` 在审核人明确逐项批准后清除运行期标记并生成新版本；工具不会自动接受业务结论。详见下述复核契约。
- `--previous-manifest` 优先于快照摘要。旧全文 diff 的脱敏策略必须能由当前或 previous 清单匹配，否则返回 `baseline-redaction-policy-unavailable`；历史摘录仍可读取已脱敏的快照值。
- `--max-bytes` 控制序列化后的 context 总大小，默认 262144，范围 4096–16777216。`budget.truncated` 与 `budget.omitted` 明示省略项；单个 diff 最多 12000 字符并带 `diffTruncated`。Git 历史和当前差异正文各自使用 `max(1 MiB, 8 × maxBytes)` 读取预算，单文件最多 8 MiB；超过预算会给出不可用原因。最低限度元数据也放不下时命令报错。

## 复核与接受契约

`review.mjs <candidate.json> [--output review.json]` 要求输入由 refresh 生成，并含 `update.mode: incremental-candidate`、`deltaPath` 和 `baseSnapshot`。允许在生成复核单前修改候选中的分析结论，但源码文件集合必须仍等于 delta 的当前版本；修改扫描范围或源码后需要重新生成 delta/candidate。

复核单 `schemaVersion: 1`、`purpose: atlas-review`，包含：

| 字段 | 规则 |
|---|---|
| `binding` | 绑定候选原文、语义清单、工作区、文件集合、基线和 delta 的哈希；不可手改 |
| `reviewer` | 审核人标识，非空字符串 |
| `reviewedAt` | 带时区的 ISO 日期时间，例如 `2026-09-29T09:00:00+08:00` |
| `items[].key/kind/detail/fingerprint` | 工具生成的完整任务集合，不可删除、复制、改写描述或指纹 |
| `items[].decision` | 初始 `pending`；仅 `approved` 允许接受，其他值会阻止接受 |
| `items[].note` | 每项必须有非空的审核说明；未归属文件应说明归属或不影响结论的依据 |

任务覆盖全部模块、视图、链路及阶段、发现项、覆盖项、数据对象、接口、配置、移除证据、未解析证据、未归属变更和分析边界。复核单不覆盖既有文件；需要重建时选择新的 `--output`。任务中的公开描述遵循清单的全局脱敏策略。

`accept.mjs <candidate.json> --review review.json [--output-dir ...]` 逐项校验审批、候选、基线及源码版本，执行正式 build，在成功后将暂存目录整体改名为新版本目录。已有目录拒绝覆盖。正式清单、报告、新基线和复核回执分别为 `atlas.json`、`report.html`、`snapshot.json`、`review.json`；默认位于 `.repo-atlas/accepted/<version>/`，建议保留这个位置以排除生成文件参与扫描。任一步骤失败时不发布新版本。原始清单、基线、delta 和复核单保留。

清单新增顶层 `review` 保存审核人、审核时间、接受时间、版本及绑定摘要；它属于运行期记录，不参与语义清单哈希。普通 build 重建带 review 的正式版本时会检查源码与语义是否仍匹配；变化后需重新进入增量复核。回执保留逐项决定及说明，是本地审核声明与一致性记录，不是身份认证或数字签名。

未解析证据始终阻止接受，即使其任务被填为 approved。可以修复锚点，或者明确移除不成立的引用并调整结论，然后重新准备复核。`build.mjs --review` 可生成检查用报告：保留缺失/歧义原因，显示“仅供复核”，不生成假的摘录或行号；受影响阶段的 covered/partial 转为 unknown，confirmed 发现项转为 unverified，原声明保留为 `declaredStatus`。这些是报告模型的临时状态，不写回原清单。路径越界等错误不会因 review 模式被忽略。

## 离线定位链接

视图、链路、阶段和证据使用 `#view=...&chain=...&stage=...&evidence=...` 片段；所有值通过 URLSearchParams 编码。旧的 `#<view-id>` 仍受支持。点击复制详情/阶段链接后，接收者可直接进入该位置；阶段高亮，证据弹窗可返回链路。不存在或不一致的定位信息会提示目标不可用。

证据 key 使用 `<entity-kind>:<entity-id>:<source-id-or-index>`；阶段证据为 `chain:<chain-id>/<stage-id>:<source-id-or-index>`。配置 source.id 可在数组重排后保持链接稳定。离线报告移动到其他路径时保留 # 片段即可；复制的完整 file URL 只适用于原机器的文件位置。

## 模块和视图

- 模块、视图、链路、阶段、发现项和覆盖项的 id：小写字母起始，只含小写字母、数字、`_`、`-`，各自最长 64 字符；阶段 id 在所属链路内唯一。`catalog` 是生成器保留视图。
- 模块：id/name/summary/facts/sources 必填。sources 至少一项；links 指向已有模块 id；icon 是 Lucide 图标名，可省略。
- 视图：id/title/diagram/modules 必填。subtitle/group/tags/notes 为说明；notes 是 `[标题, 内容]` 数组。`sources` 可为整张图补充直接依据，适合记录注册点、核心编排或关系约束；图中重要结论仍需能追溯到模块或视图证据。
- flowchart 的节点 id 与模块 id 相同即可点击查看该模块；非 flowchart 用下方关联模块访问说明。
- `mobileDiagram` 可提供同义纵向变体；不提供时保留完整图和缩放能力。
- flowchart 默认追加 entry/core/process/support/external/planned 类定义。需要完全自定义主题时 `useDefaultClasses: false`。
- `aliases` 对象把图内短名映射到实际表、集合、队列或文件名称。
- 可用 `legend` 自定义该视图图例：`[{"label":"业务模块","color":"#8ebba6"}]`；颜色必须为六位十六进制。非 flowchart 默认不展示业务分类图例。

## 业务链路与阶段覆盖

复杂项目不要只用一张总览图承载所有业务关系。`chains` 描述需要闭环核对的业务链路，每条链路用 `stages` 把入口、校验、编排、数据读写、副作用、结果和失败恢复拆成可复核阶段。链路自己的 `sources` 证明它确实存在；阶段的 `sources` 证明该阶段的实现位置。

```json
{
  "chains": [
    {
      "id": "order_create",
      "title": "订单创建闭环",
      "kind": "核心写入链路",
      "summary": "从创建请求到订单状态与库存副作用完成。",
      "trigger": "POST /orders",
      "outcome": "订单进入可查询状态并发布领域事件",
      "modules": ["api", "order", "inventory"],
      "views": ["order_flow", "order_state", "order_data"],
      "stages": [
        {
          "id": "entry",
          "label": "入口与鉴权",
          "status": "covered",
          "summary": "路由注册和权限中间件确认调用者边界。",
          "modules": ["api"],
          "sources": [{ "path": "src/routes.ts", "match": "router.post('/orders'", "length": 8 }]
        },
        {
          "id": "persist",
          "label": "业务写入",
          "status": "partial",
          "summary": "已确认订单写入，事务与库存一致性仍需核对。",
          "nextCheck": "检查订单写入和库存扣减是否共享事务或补偿路径。",
          "modules": ["order", "inventory"],
          "sources": [{ "path": "src/order-service.ts", "match": "createOrder(", "length": 12 }]
        },
        {
          "id": "failure",
          "label": "失败与恢复",
          "status": "unknown",
          "summary": "当前范围尚未确认库存失败后的订单状态迁移。",
          "nextCheck": "追踪库存客户端异常到订单状态更新和重试策略。",
          "modules": ["order", "inventory"],
          "sources": []
        }
      ],
      "sources": [{ "path": "src/order-service.ts", "match": "createOrder(", "length": 18 }]
    }
  ]
}
```

- `chains` 可以为空，简单项目不必强行创建链路；复杂项目每条关键业务链都应有一项。
- `stages` 至少三项，推荐按“入口与权限、校验与编排、数据读写、外部副作用、结果与下游、失败恢复”拆分；状态只能使用 `covered`、`partial`、`unknown`、`not_applicable`。
- 阶段可用 `kind` 标注稳定语义：`entry`、`authorization`、`validation`、`orchestration`、`read`、`write`、`side_effect`、`publication`、`consume`、`outcome`、`recovery` 或 `custom`。首阶段通常应为 `entry` / `authorization` / `validation`，末阶段通常应为 `outcome` / `recovery`；生成器会对不一致情况给出质量提醒。
- `covered` 和 `partial` 阶段必须有证据；`unknown` 必须填写 `nextCheck`，不能用空证据伪装成已核对。
- `views` 把链路绑定到关系图或流程说明。链路顺序优先由 `chains.stages` 的自然语言摘要、`trigger` 和 `outcome` 说明；不要求创建时序图。链路没有绑定 `narrative` / `sequence` 视图时，生成器会自动创建一张流程说明视图。需要回答状态迁移、数据约束、一致性、失败恢复或部署边界时，再补充对应关系图。
- 视图可选填 `kind`（`overview`、`flow`、`narrative`、`sequence`、`state`、`data`、`deployment`、`recovery`、`dependency`、`mindmap`、`custom`）；省略时根据 Mermaid 首行推断。`narrative` 不需要 `diagram`，适合直接承载业务流程说明；`sequence` 仅作为旧清单的可选源码依据保留，报告前端会转为自然语言流程说明而不展示密集时序画布。链路关联视图中的模块应覆盖 `chain.modules`，否则报告会标记为待复核。
- 报告会展示链路阶段进度、触发与结果、关联图和证据索引；阶段进度是证据覆盖度，不是系统质量评分。
- 阶段进度使用 `covered / 适用阶段数`，`not_applicable` 单独列出，`partial` 不折算为半个已覆盖阶段。无适用阶段的链路显示“不适用”，不进入“已覆盖”筛选。阶段的 `reviewRequired` 或 `freshness` 为 `stale`、`unresolved`、`historical` 时，链路同时展示待复核状态；不改变原有覆盖状态。

## 发现项与覆盖矩阵

`findings` 用于提炼会影响理解、变更或运行判断的结论，不是代码观察的堆积，也不替代专项审计。每项必须有源码证据：

```json
{
  "findings": [{
    "id": "async_only",
    "title": "创建请求只完成入队",
    "kind": "fact",
    "status": "confirmed",
    "summary": "HTTP 成功仅表示任务已写入队列，结果由 worker 稍后生成。",
    "impact": "调用方不能把 202 响应解释为资料已生成。",
    "nextCheck": "",
    "modules": ["api", "worker"],
    "sources": [{"path": "src/routes.ts", "match": "queue.add(", "length": 10}]
  }]
}
```

- `kind`：`fact`、`risk`、`gap`、`decision`。
- `status`：`confirmed`、`inferred`、`unverified`。`unverified` 必须提供 `nextCheck`。
- `modules` 只引用已有模块；`sources` 至少一项。推断也必须说明它基于哪些可见实现。
- `impact` 和 `nextCheck` 可省略；只有确实影响读者判断时才填写。

`coverage` 说明本次分析检查了什么、哪里仍不完整。维度由项目和范围决定，不要机械复制通用清单：

```json
{
  "coverage": [
    {
      "id": "authorization",
      "area": "认证与授权",
      "status": "partial",
      "summary": "已确认 API 中间件，但未核对后台任务的租户边界。",
      "nextCheck": "追踪 worker 消费消息后如何恢复 tenantId。",
      "modules": ["api", "worker"],
      "sources": [{"path": "src/middleware/auth.ts", "match": "requireUser", "length": 8}]
    },
    {
      "id": "transactions",
      "area": "事务与一致性",
      "status": "unknown",
      "summary": "当前范围尚未读到事务边界。",
      "nextCheck": "检查数据库客户端封装和创建链路的提交位置。",
      "modules": [],
      "sources": []
    }
  ]
}
```

- `status`：`covered`、`partial`、`unknown`、`not_applicable`。
- `covered` 和 `partial` 至少需要一处证据；`unknown` 必须给出最短 `nextCheck`；`not_applicable` 应在 summary 中解释原因。
- 覆盖状态表示本次报告的证据充分度，不表示系统实现质量，也不是百分比评分。

增量刷新时，模块、视图、发现项和覆盖项可以带以下运行期字段；构建器会原样保留并在报告中提示：

```json
{
  "freshness": "stale",
  "reviewRequired": true,
  "staleReason": "源码证据在快照后发生变化"
}
```

`fresh`、`stale`、`unresolved`、`historical` 只描述证据新鲜度，不改变 `confirmed` / `inferred` / `unverified` 的语义。

## 可选索引

为保持轻量，只有确认需要的条目才填。空索引标签会隐藏，不要求非数据库项目创建数据表。

```json
{
  "tables": [{
    "name": "orders", "title": "订单集合", "kind": "当前事实",
    "description": "保存当前订单；通过 customerId 关联客户。",
    "sources": [{ "path": "src/store.ts", "match": "collection('orders')", "length": 6 }]
  }],
  "routes": [{
    "prefix": "POST /orders", "name": "createOrder", "kind": "HTTP",
    "description": "创建订单的已注册入口。",
    "sources": [{ "path": "src/routes.ts", "match": "router.post('/orders'", "length": 5 }]
  }],
  "flags": [{
    "name": "worker.enabled", "value": true,
    "description": "此文件默认值，未查询运行时覆盖。",
    "sources": [{ "path": "config/defaults.yaml", "match": "worker:", "length": 2 }]
  }]
}
```

`tables` 是通用的数据对象索引，也可列文件、消息或集合。routes 可表示已确认的 HTTP、CLI、订阅事件等入口，不自动推断注册关系。flags 仅放经过检查可公开的值和来源。发现项、覆盖矩阵、对象、入口、文件和配置会统一出现在报告的证据索引中；空类型自动隐藏。

## 验证

`verify.mjs` 读取最终 HTML 内的实际数据，不依赖固定图数或业务名称。可用 `--playwright <index.js>` 指定现有 Playwright 包，用 `--channel chrome|msedge` 或 `REPO_ATLAS_BROWSER_CHANNEL` 选择本机浏览器通道。脚本不下载浏览器。无浏览器环境只能完成生成期校验；页面验证结果应如实说明，不能伪造 JSON。
