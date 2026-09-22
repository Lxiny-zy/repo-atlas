# atlas.json 输入契约

生成器执行指定证据的提取与索引统计，不从目录自动推断业务架构。输入使用 UTF-8 JSON，不使用可执行 JavaScript 配置。

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
- 快照同时保存原始 `manifestSha256` 与排除候选运行期字段后的 `analysisManifestSha256`；后者用于避免仅刷新 UI 状态时重复触发全量复核。
- 重命名只在删除与新增文件的 SHA-256 相同且一一配对时报告为 `renamed`；重命名同时修改内容时保留为 `deleted` + `added`，不猜测关系。`--snapshot-output` 不能覆盖 `--from` 指定的基线。
- 删除源文件不会让增量计算中断：对应证据会保留路径、`resolved: false`、空哈希和 `staleReason`。首次正式报告生成仍由 `build.mjs` 严格拒绝缺失或歧义锚点。
- `manifestChanged` 表示分析清单本身发生变化（候选 `update` 字段和运行期 freshness 标记会被排除在比较之外）；它会触发全量复核建议，避免只改结论或证据定义时静默沿用旧判断。
- `summary.changedFileRatio` 是相对基线文件数的本地变更比例；基线至少 10 个文件且比例超过 20%，或一次变更达到 20 个文件时，默认建议全量重分析。
- `summary.fullReanalysisReasons` 记录触发全量建议的具体原因，交给模型或人工复核时优先处理这些原因，而不是盲目重读整个仓库。
- 证据所引用的文件每次增量都会重新计算 SHA-256；未被证据引用的文件在大小、修改时间和变更时间均未变化时可复用本地哈希缓存。这些优化只影响本地 I/O，不改变模型复核范围。
- `refresh.mjs` 生成的 `update` 字段是候选状态；只有重新检查受影响证据并确认后，才应把 `atlas.next.json` 替换为新的分析清单和快照。
- 所有源码链接按输出目录自动生成相对路径；把 HTML 单独发出后内嵌摘录仍可读，链接需要原始仓库结构。
- 项目无 Git 时省略 repositories，不虚构分支。配置了 Git 仓库但读取失败会报错，不静默把失败当成干净工作区。
- 文件索引只扫描显式指定的后缀和路径；按真实路径去重，不扫描符号链接目录，默认排除 `.git`、`.repo-atlas`、`node_modules`、`.venv`、`__pycache__`。不将快照产物或整个环境文件加入文件索引或证据。

## 证据字段

```json
{ "path": "src/store.ts", "match": "export async function saveOrder(", "length": 14, "occurrence": 1, "redact": ["需要遮盖的字面值"] }
```

`match` 是字面文本，必须实际出现；重复出现时必须提供从 1 起算的 occurrence，优先选择唯一锚点。`length` 默认 8、最多 60 行。生成器写出真实行号，不接受手填摘录冒充源码。`redact` 仅替换摘录值，源文件不变；含遮盖值的原始清单也要留在合适的位置，不把敏感值填进可分发配置。

## 模块和视图

- 模块、视图、发现项和覆盖项的 id：小写字母起始，只含小写字母、数字、`_`、`-`，最长 64 字符。`catalog` 是生成器保留视图。
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
      "views": ["order_sequence", "order_state", "order_data"],
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
- `covered` 和 `partial` 阶段必须有证据；`unknown` 必须填写 `nextCheck`，不能用空证据伪装成已核对。
- `views` 把链路绑定到多张关系图。复杂链路至少应有一张时序图，并按需要补充状态、数据、一致性、失败恢复或部署视图。
- 报告会展示链路阶段进度、触发与结果、关联图和证据索引；阶段进度是证据覆盖度，不是系统质量评分。

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
