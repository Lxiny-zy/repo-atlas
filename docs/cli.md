# CLI reference / 命令参考

以下命令从 repo-atlas 根目录运行；在其他目录使用脚本绝对路径。`<...>` 和 `VERSION` 是占位符，不应原样复制。

## 公共规则

- 所有用户命令支持 `--help` 和 `-h`，帮助输出到 stdout、退出码为 0。
- 布尔选项可放在位置参数之前或之后，不会吞掉文件名；例如 `compare.mjs --json old.json new.json`。
- 带值选项支持 `--output file.json` 和 `--output=file.json`；值中的 `=` 保留。
- `--` 结束选项解析，其后的内容均为位置参数。
- 未知选项、重复长选项、缺值、错误的位置参数数量：退出码 2，在读取清单或生成输出前拒绝。
- 成功退出码为 0；验证或运行失败为 1。`validate --json` 的清单错误使用结构化诊断；其他命令的运行错误目前可能包含 Node 堆栈。
- 未传 `--json` 的命令也可能输出 JSON 摘要，不应依赖终端文字推断审核状态。

## 路径与覆盖策略

| 参数 | 解析基准 | 输出/覆盖规则 |
|---|---|---|
| 命令行清单路径 | 当前工作目录 | 只读输入 |
| `manifest.workspace` | 清单所在目录 | 实际源码根目录 |
| 证据路径、fileGroups、manifest.output | workspace | 不允许越界 |
| snapshot/delta/context/refresh/review/accept 的路径选项 | workspace | 受输入保护及链接边界约束 |
| compare 的两个输入 | 当前工作目录 | 不要求源 workspace 存在 |
| compare `--output` | 当前工作目录 | 必须在当前目录内；新文件默认，已有文件需 `--replace` |
| verify 报告路径、check-delivery 版本目录 | 当前工作目录 | 分别验证报告和已有交付 |

build 默认禁止覆盖，`--replace` 允许更新已有 HTML。review 禁止覆盖复核单；accept 总是新建版本目录。snapshot、delta、context、refresh 可以原子替换各自的既有生成结果，但禁止覆盖其输入或源码。这些策略不同，是为了区分可重算中间结果与审核记录。

compare 的新防护改变了旧行为：以前任意 `--output` 会直接写入；现在越过当前目录的输出被拒绝，已有文件须显式替换，两个输入及其链接别名始终受保护。

## 生成与校验

```sh
node scripts/validate.mjs <atlas.json> [more.json ...] [--json] [--structure-only] [--review]
node scripts/build.mjs <atlas.json> [--replace] [--review]
```

validate 聚合类型、未知字段、重复 ID、无效引用、路径和证据诊断，使用 JSON Pointer 定位。`--structure-only` 跳过文件系统证据检查；`--review` 将缺失或歧义证据降为警告，路径越界仍报错。两者同时使用时结构模式优先。

validate 不重建完整目录索引，不验证 Git、图形渲染或审核绑定。build 生成正式报告时保持严格证据要求；`--review` 生成明确标注用途的临时预览。

## 快照、差异与候选

```sh
node scripts/snapshot.mjs <atlas.json> [--output .repo-atlas/snapshot.json] [--from snapshot.json]
node scripts/delta.mjs <atlas.json> [--from .repo-atlas/snapshot.json] [--output .repo-atlas/delta.json] [--snapshot-output current.json]
node scripts/context.mjs <atlas.json> [--from snapshot.json] [--delta delta.json] [--output context.json] [--changed-only] [--stale-only] [--previous-manifest old.json] [--max-bytes 262144]
node scripts/refresh.mjs <atlas.json> [--delta .repo-atlas/delta.json] [--from snapshot.json] [--output atlas.next.json]
```

- snapshot 保存 v2 基线；`--from` 可为非证据文件提供哈希缓存，但输出必须与输入基线不同。
- delta 默认读取 `.repo-atlas/snapshot.json`，输出变更、失效证据和影响索引；`--snapshot-output` 额外保存当前快照。
- context 默认读取同目录的 snapshot/delta 并输出 `.repo-atlas/context.json`；`--out` 是 `--output` 的兼容别名，勿同时指定。`--max-bytes` 范围为 4096–16777216。
- context 的 `--changed-only` 聚焦变化内容，`--stale-only` 聚焦失效证据；历史全文无法核对时保留已脱敏历史摘录并说明原因。
- refresh 默认把候选写在原清单旁。自定义位置会调整 workspace 和相对 `$schema` 链接，保留未关闭的复核项。
- delta 后继续改源码会使 context/refresh 校验失败；重新生成 delta 再继续。

## 复核与接受

```sh
node scripts/review.mjs <atlas.next.json> [--output .repo-atlas/review.json]
node scripts/accept.mjs <atlas.next.json> --review .repo-atlas/review.json [--output-dir .repo-atlas/accepted/VERSION]
```

review 生成待填写的任务。审核人须填写身份说明、带时区时间及逐项决定与理由；不要修改任务描述、指纹或绑定字段。`pending`、`deferred`、`needs_changes` 都不能接受。接受前再次检查源码、候选和基线，并执行严格 build。

accept 原子发布新的版本目录；失败时清理暂存目录。复核记录是本地声明，不是身份认证。

后续以已接受版本继续增量，所有相对 `--from` 仍以原 workspace 为基准：

```sh
node scripts/delta.mjs .repo-atlas/accepted/VERSION/atlas.json --from .repo-atlas/accepted/VERSION/snapshot.json
node scripts/context.mjs .repo-atlas/accepted/VERSION/atlas.json --from .repo-atlas/accepted/VERSION/snapshot.json --changed-only
node scripts/refresh.mjs .repo-atlas/accepted/VERSION/atlas.json --output docs/architecture/atlas.next.json
```

该示例假设当前目录就是源码 workspace。refresh 从 delta 的 `from.path` 获取基线，也可显式传入 `--from`。

## 比较与交付完整性

```sh
node scripts/compare.mjs <base.json> <head.json> [--output changes.json] [--json] [--replace]
node scripts/check-delivery.mjs [accepted-directory]
```

compare 比较 modules、views、chains、stages、findings、coverage、tables、routes、flags，以及项目/文件分组/仓库描述。仅在实体定义的位置排除 freshness、reviewRequired、staleReason；任意 JSON 业务值中的同名键保留。顶层 output/workspace/schema/review/update 不参与语义变化统计。更换对象数组顺序可能改变承载顺序语义的字段；它不是源码 diff。

check-delivery 默认当前目录，验证 delivery.json 绑定的文件字节、哈希、长度与快照摘要；拒绝越界链接或缺失/损坏的绑定。它不重新扫描当前源码，也不证明回执发布者的身份。需要确认源码仍一致时应使用正常的增量/复核工作流。

## 浏览器验证与性能基准

```sh
node scripts/verify.mjs <report.html> [--playwright installed-playwright/index.mjs] [--browser chromium|firefox|webkit] [--channel chrome|msedge]
node scripts/benchmark.mjs [--scales 1000,10000] [--samples 1] [--extra-evidence 0] [--groups 1] [--git]
```

verify 可从 `REPO_ATLAS_PLAYWRIGHT_PATH` 获取包路径，从 `REPO_ATLAS_BROWSER_CHANNEL` 获取 Chromium channel。`--channel` 只适用于 chromium。结果和截图写到报告旁的 `*.verification/`；显式指定浏览器时在其下按引擎分目录。

benchmark 在临时目录生成合成源码并清理，只输出 JSON。`--samples` 为 1–10，`--extra-evidence` 为 0–1000，`--groups` 为 1–20，单规模为 10–50000 文件。`--git` 创建本地合成基线，不访问远端。增加 evidence 时会有被引用文件发生变化，因此不同场景的 context 大小不可直接混同。

结果保留每次采样和各规模的中位数/最近秩 p95。少量采样不构成延迟分布承诺；RSS 仅为当前快照进程的采样值，不包含子进程，重复样本间进程内存不会重置。
