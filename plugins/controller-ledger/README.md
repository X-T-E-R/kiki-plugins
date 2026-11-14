# Controller Ledger

把当前工作、负责人、真正依赖、待拍板事项和证据放进工作区账本。用两个原生工具按条更新，不必反复改写一整份队列。先记住一条，再逐渐补齐目标与完成条件。

账本是主控的工作状态，不是执行器。它不会派人、发消息、控制后台任务或判断产品已验收；原生 Task、Board、Memory 和 History 保持各自职责，用 `refs`、`evidence` 关联即可。长期偏好仍写进 Memory。

## 安装与调用

需要支持原生插件工具的 Kiki plugin engine `0.4.x`，运行 Node ≥24.15。插件不需要 npm 安装、外部数据库、服务或 API key。

在 Kiki 中执行（把路径换成本地源码目录）：

```text
/plugins install --trust ./plugins/controller-ledger
/plugins enable controller-ledger
```

首次信任允许插件以本机用户权限执行代码。工具可在原对话中使用；源码变更后对同一路径再次 `/plugins install`，托管副本才会更新，且保留启用状态。不要只修改源码后调用 `/plugins reload`。短提示词的生效遵循宿主提示词重建时机；当前会话可直接调用 `brief`，无需为工具强重启。

模型看到的工具名：

- `plugin__controller_ledger__ledger_read`
- `plugin__controller_ledger__ledger_write`

每次传 `workspace: "."`，使用宿主的 `context.workspaceRoot`。宿主文件准入要求路径字段存在，因此这个参数不能省略。要访问另一个工作区，显式传其根目录并由宿主准入；不同根目录的账本互不混合。

### 快速捕捉，再补信息

写入只要求稳定请求键、操作和条目标题：

```json
{
  "workspace": ".",
  "requestKey": "capture-example-1",
  "operations": [{
    "action": "create",
    "id": "example-build",
    "set": { "title": "完成本机示例" }
  }]
}
```

然后局部补齐；未传字段不变。`actor`、`basis` 可记录此次更新者和事实依据，省略时保留为未提供，不猜测来源。

```json
{
  "workspace": ".",
  "requestKey": "enrich-example-1",
  "actor": "controller",
  "basis": "已明确负责人和本轮完成条件",
  "operations": [{
    "action": "patch",
    "id": "example-build",
    "set": {
      "goal": "本机调用可以保存并恢复工作状态",
      "success": ["成功调用后重启仍能读到条目"],
      "owner": "implementation-owner",
      "state": "active",
      "nextAction": "走一次真实调用",
      "refs": [{ "kind": "task", "ref": "external-task-reference" }]
    }
  }]
}
```

`set` 只替换所列字段；数组也整字段替换，传 `[]` 清空。追加证据或决定用 `append`，并发时不覆盖另一份追加：

```json
{
  "workspace": ".",
  "requestKey": "evidence-example-1",
  "basis": "观察到真实调用持久化",
  "operations": [{
    "action": "patch", "id": "example-build", "set": { "state": "delivered" },
    "append": { "evidence": [{ "kind": "document", "ref": "analyses/example-evidence.md" }] }
  }]
}
```

同一 `requestKey` 和相同写入内容重试返回原回执，不再写一次；复用请求键但内容不同会报 `request_key_reused`。一次写入可含最多 50 条操作，整个批次原子提交。不同写入用新键。

## 读当前工作与完整详情

首次使用、恢复上下文或接续工作时：

```json
{ "workspace": ".", "view": "brief" }
```

平时按需要读，不自动注入整个账本：

| view | 返回内容 |
| --- | --- |
| `overview` / `brief` | 当前条目、下一动作、关键决定及缺口；brief 默认 10 条 |
| `ready` / `next` | planned/active 的 task，且全部直接依赖已 accepted、没有依赖环 |
| `blocked` | 显式 blocked/awaiting_decision，或有未满足依赖的条目 |
| `pending-decisions` | 尚未关闭的 decision |
| `search` | 按 `query` 不区分大小写定位条目，包括完整保存的文字与引用 |
| `get` | 传 `id`，返回单条全部字段和计算信息 |
| `history` | 传 `id`，按修订倒序返回更新者、依据、请求键和字段变化 |
| `export` | 全账本与修订，`format: "json"` 或 `"markdown"` |

活跃视图默认不含 accepted/cancelled/archived；`includeCompleted: true` 可查关闭工作，`get` 和 `history` 始终可点查。紧凑视图的引用/证据显示数量，长字段明确列在 `shortenedFields`，用 `get` 查看原文。

默认列表每页 25 条（brief 10 条），`limit` 可设为 1–100。返回 `cursor` 时，保持原 view/query/limit 继续读。分页固定到首次响应的修订水位 `generation`：期间的其他更新不使续页报错，不重复或遗漏这份快照内的条目；新条目或新状态在新一次读取中出现。响应同时显示 `currentGeneration` 和快照范围。

小响应直接返回 `items`、`item` 或 `revisions`；超过文字预算的页/详情/导出返回 `text`、`totalChars`、`nextTextOffset`。先用相同参数、同一 cursor（如有），并传 `textOffset: nextTextOffset` 与 `atGeneration: generation` 读完当前内容，再进入下一个列表 cursor。这段文字在 `nextTextOffset` 为 `null` 时结束；`complete` 只表示当前响应是否已含全文，不能用来判断还有没有下一页。不会悄悄丢掉超长详情；`maxChars` 可设 1000–24000。

### 状态与依赖

状态为 `planned`、`active`、`blocked`、`awaiting_decision`、`delivered`、`accepted`、`cancelled`、`archived`。它们只记录更新者的明确判断：后台任务结束不会改变账本，`delivered` 也不会自动变成 `accepted`。缺少目标、完成条件、负责人、下一动作或 acceptance evidence 会以 `informationGaps` 提示，不阻止捕捉和状态更新。归档后可 patch 原 ID 的状态重新开展工作，信息与历史保留。

`dependsOn` 填同账本 ID；未创建的 ID 显示 `missingDependencies`，环显示具体 `dependencyCycle`，并阻止计算 ready，而不是阻止登记。accepted 的依赖满足就绪；从 accepted 归档的依赖仍满足。cancelled 或其他状态不视为满足。外部 Task/Agent 的运行状态仅作为引用，不自动同步或授予权限。

待拍板记录用 `kind: "decision"`，可逐渐填 `options`、`decision`、`success` 和证据；任务依赖其 ID 即可在 blocked 视图看见等待。

### 处理真正的并发冲突

普通 patch 不需要先读 revision。事务会读取最新记录，只改命名字段；其他字段保留。需要防止旧判断覆盖同一字段时，传 `baseRevision`（上一次 `get` 的 `item.revision`）：无关字段的并发变化合并，同一命名字段变化且提出的值不同则返回 `stale_conflict`，列出 `current` 与 `proposed`。读该条目/历史，协调这几个字段后用新请求键重试。无需每次 CAS 人工确认。

## 数据位置、备份与独立脚本

每个工作区使用 `<workspace>/.controller-ledger/ledger.sqlite`，由 Node 内置 SQLite 管理，WAL + FULL 同步与事务保证并发/原子提交。数据不在插件包、Kiki 托管代码目录或 `.assay/` 中，重装插件不会覆盖数据。SQLite 的 `items.body`、`revisions.body`、`requests.receipt` 是可读 JSON；可以用 SQLite 客户端只读检查。不要手工写入机器表。

账本包含工作内容和证据路径，请按工作区敏感数据备份；不应把私人账本提交到公开仓库。备份可用导出工具，或 SQLite 一致性备份；不要只拷贝正在写入的 `.sqlite` 而漏掉 WAL。插件移除不删除账本。

独立 CLI 与原生工具复用同一模块，不需要启动 Kiki：

```sh
node scripts/ledger.mjs read . request.json
node scripts/ledger.mjs write . write-request.json
node scripts/ledger.mjs export . json ./ledger.json
node scripts/ledger.mjs export . markdown ./ledger.md
```

请求文件用上述 JSON，可省略 `workspace`（脚本使用命令行工作区）。CLI 导出在同一只读事务中逐页写入文件，不在内存拼接全文；省略输出路径时逐页写入 stdout。输出文件使用 exclusive create，不覆盖已有备份；失败或取消时关闭并删除本次创建的半成品。已经写入 stdout 的内容不会撤回。

使用原生 `export` 视图时，从偏移 0 开始，沿用首页 `generation`，用 `nextTextOffset` 续读直到它为 `null`。多页导出的最后一页仍是 `complete: false`。CLI 是用户本地直接操作，原生工具的外部目录仍受宿主文件准入。写入批次在提交前取消会整体回滚；已提交内容保留，用同一请求键重试可取得原回执。

旧 Markdown 队列可作为引用来源保留。先理解其中仍在进行的工作，再用一个 create 批次导入必要条目；不要把旧日志自动拆成大量伪任务，也不要覆盖原文。

## 开发检查

```sh
node scripts/sync-manifest.mjs
npm test
```

`lib/definitions.mjs` 是工具定义单源，manifest 由脚本生成；测试校验 manifest 和注册定义一致。`entry.mjs` 只适配宿主和可恢复错误，`lib/ledger.mjs` 实现账本；没有第三方运行依赖。
